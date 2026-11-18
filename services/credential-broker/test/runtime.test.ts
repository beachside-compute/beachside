import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import type { V4MiniflareOptions } from "miniflare";
import { z } from "zod";
import { createCredentialBroker } from "../../../packages/credential-client/src/index";
import { tokenHash } from "../src/grants/tokens";

const apiKey = "orchestration-fixture-key-1234567890";

const issuer = "https://token.actions.githubusercontent.com";

const audience = "https://broker.test/github-actions";

const secret = {
  github: "github_upstream_fixture_key",
  openai: "openai_upstream_fixture_key",
  anthropic: "anthropic_upstream_fixture_key",
  openrouter: "openrouter_upstream_fixture_key",
};

const kinds = ["github", "openai", "anthropic", "openrouter"] as const;

const policy = {
  repositoryId: "100",
  repositoryOwnerId: "200",
  repository: "beachside-compute/fixture",
  ref: "refs/heads/main",
  workflowRef: "beachside-compute/fixture/.github/workflows/review.yml@refs/heads/main",
  event: "pull_request_target",
  integrations: ["github"],
};

const config = {
  integrations: kinds.map((kind) => ({
    kind,
    id: kind,
    credential: { source: "worker-secret", binding: `CREDENTIAL_${kind.toUpperCase()}` },
  })),
  githubActions: { audience, workflows: [policy] },
};

const claims = {
  repository_id: policy.repositoryId,
  repository_owner_id: policy.repositoryOwnerId,
  repository: policy.repository,
  ref: policy.ref,
  workflow_ref: policy.workflowRef,
  event_name: policy.event,
  run_id: "300",
};

const grantSchema = z.object({
  id: z.uuid(),
  token: z.string().regex(/^bsg_[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
});

const keys = await generateKeyPair("RS256");

const wrongKeys = await generateKeyPair("RS256");

const jwk = { ...(await exportJWK(keys.publicKey)), kid: "fixture" };

const seen: { url: URL; method: string; headers: Headers; body: string }[] = [];

let runtime: Miniflare;

let gitRoot: string;

let sendStreamTail: (() => void) | undefined;

async function buildWorker() {
  const result = await build({
    entryPoints: [`${import.meta.dir}/../src/index.ts`],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    define: {
      "navigator.userAgent": '"Cloudflare-Workers"',
      "process.env.NODE_ENV": '"undefined"',
    },
    external: ["cloudflare:*"],
    loader: { ".sql": "text" },
  });

  return result.outputFiles[0].text;
}

const options: V4MiniflareOptions = {
  name: "broker",
  modules: true,
  script: await buildWorker(),
  compatibilityDate: "2026-09-25",
  unsafeInspectDurableObjects: true,
  durableObjects: {
    REGISTRY: { className: "GrantRegistry", useSQLite: true },
  },
  bindings: {
    BROKER_API_KEY: apiKey,
    BROKER_CONFIG: JSON.stringify(config),
    CREDENTIAL_GITHUB: secret.github,
    CREDENTIAL_OPENAI: secret.openai,
    CREDENTIAL_ANTHROPIC: secret.anthropic,
    CREDENTIAL_OPENROUTER: secret.openrouter,
  },
  async outboundService(request) {
    const url = new URL(request.url);

    if (url.href === `${issuer}/.well-known/jwks`) {
      return RuntimeResponse.json({ keys: [jwk] });
    }

    if (url.hostname === "external.invalid") {
      throw new Error("Outbound fixture made an unexpected request");
    }

    if (url.hostname === "github.com") {
      expect(request.headers.get("authorization")).toBe(
        `Basic ${btoa(`x-access-token:${secret.github}`)}`,
      );

      return gitHttpBackend(
        url,
        request.method,
        request.headers.get("content-type"),
        await request.arrayBuffer(),
      );
    }

    seen.push({
      url,
      method: request.method,
      headers: new Headers([...request.headers]),
      body: await request.text(),
    });

    if (url.hostname === "api.openai.com" && url.pathname === "/v1/chat/completions") {
      return sseFixture();
    }

    if (url.pathname === "/repos/org/demo/issues/99") {
      return new RuntimeResponse(null, {
        status: 307,
        headers: { location: "https://api.github.com/repos/org/demo/issues/42" },
      });
    }

    if (url.pathname === "/repos/org/moved/issues") {
      return new RuntimeResponse(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/123/issues" },
      });
    }

    if (url.pathname === "/repos/org/moved") {
      return new RuntimeResponse(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/123" },
      });
    }

    if (url.pathname === "/repos/org/redirect") {
      return new RuntimeResponse(null, {
        status: 302,
        headers: { location: "https://external.invalid/credential-collector" },
      });
    }

    if (url.pathname === "/repos/org/demo") {
      return RuntimeResponse.json({ full_name: "org/demo" });
    }

    if (url.pathname === "/repositories/123/issues") {
      if (url.searchParams.get("page") === "2") return RuntimeResponse.json([{ number: 42 }]);

      return RuntimeResponse.json([{ number: 41 }], {
        headers: { link: '<https://api.github.com/repositories/123/issues?page=2>; rel="next"' },
      });
    }

    if (url.pathname === "/repos/org/demo/issues" && request.method === "POST") {
      return RuntimeResponse.json({ number: 42 }, { status: 201 });
    }

    if (url.pathname === "/graphql") {
      const { body } = seen.at(-1)!;
      const query = z.object({ query: z.string() }).parse(JSON.parse(body)).query;

      return graphqlFixture(query);
    }

    return RuntimeResponse.json({ fixture: true });
  },
};

beforeAll(async () => {
  gitRoot = await mkdtemp(join(tmpdir(), "beachside-broker-"));
  runtime = startRuntime();
});

afterAll(async () => {
  await runtime?.dispose();

  if (gitRoot) await rm(gitRoot, { recursive: true, force: true });
});

async function issue(integrations: string[], authority = apiKey, ttlSeconds = 60) {
  return runtime.dispatchFetch("https://broker.test/v1/grants", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authority}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ integrations, ttlSeconds }),
  });
}

async function grant(integrations: string[], authority = apiKey, ttlSeconds = 60) {
  const response = await issue(integrations, authority, ttlSeconds);
  expect(response.status).toBe(201);

  return grantSchema.parse(await response.json());
}

function access(path: string, token: string, method = "GET", body?: string) {
  return runtime.dispatchFetch(`https://broker.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body,
    redirect: "manual",
  });
}

async function githubToken(
  overrides: Partial<typeof claims> = {},
  aud = audience,
  expiration = "5m",
  key = keys.privateKey,
) {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setSubject("repo:beachside-compute/fixture:pull_request")
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(key);
}

describe("credential broker running in workerd", () => {
  test("issues only with control authentication, persists a digest and enforces expiry/revocation", async () => {
    expect((await issue(["openai"], "wrong-key")).status).toBe(401);
    expect((await issue(["unknown"])).status).toBe(403);
    expect((await issue(["openai", "openai"])).status).toBe(400);
    expect((await issue(["openai"], apiKey, 3601)).status).toBe(400);

    const record = await grant(["openai"]);
    expect((await issue(["openai"], record.token)).status).toBe(401);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    const stored = await storage.exec("SELECT * FROM grants WHERE id = ?", record.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].hash).toBe(await tokenHash(record.token));
    expect(JSON.stringify(stored)).not.toContain(record.token);

    for (const value of Object.values(secret)) expect(JSON.stringify(stored)).not.toContain(value);

    await runtime.unsafeEvictDurableObject("broker", "GrantRegistry", { name: "grant-registry" });
    const response = await access("/gateway/openai/v1/models", record.token);
    expect(response.status).toBe(200);
    await response.text();
    expect((await access("/gateway/openrouter/v1/models", record.token)).status).toBe(403);

    const deniedRevoke = await access(`/v1/grants/${record.id}`, record.token, "DELETE");
    expect(deniedRevoke.status).toBe(401);
    expect((await access(`/v1/grants/${record.id}`, apiKey, "DELETE")).status).toBe(204);
    expect((await access(`/v1/grants/${record.id}`, apiKey, "DELETE")).status).toBe(204);
    expect((await access("/gateway/openai/v1/models", record.token)).status).toBe(401);
    expect(await storage.exec("SELECT id FROM leases WHERE grant_id = ?", record.id)).toEqual([]);

    const expiring = await grant(["openai"], apiKey, 1);
    const expiresIn = Date.parse(expiring.expiresAt) - Date.now();
    await Bun.sleep(Math.max(0, expiresIn) + 20);
    expect((await access("/gateway/openai/v1/models", expiring.token)).status).toBe(401);

    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await storage.exec("SELECT id FROM grants WHERE id = ?", expiring.id);

      if (!rows.length) break;
      await Bun.sleep(20);
    }

    expect(await storage.exec("SELECT id FROM grants WHERE id = ?", expiring.id)).toEqual([]);
  });

  test("verifies GitHub Actions signature and configured claim policy through the JWKS endpoint", async () => {
    const authority = await githubToken();
    const record = await grant(["github"], authority);
    expect((await issue(["openai"], authority)).status).toBe(403);
    const otherRun = await githubToken({ run_id: "301" });
    expect((await access(`/v1/grants/${record.id}`, otherRun, "DELETE")).status).toBe(204);
    const response = await access("/api/v3/user", record.token);
    expect(response.status).toBe(200);
    await response.text();
    expect((await access(`/v1/grants/${record.id}`, authority, "DELETE")).status).toBe(204);

    const invalid = await Promise.all([
      githubToken({}, "wrong-audience"),
      githubToken({}, audience, "-5m"),
      githubToken({}, audience, "5m", wrongKeys.privateKey),
      githubToken({ repository_id: "101" }),
      githubToken({ repository_owner_id: "201" }),
      githubToken({ repository: "fork/fixture" }),
      githubToken({
        workflow_ref: "beachside-compute/fixture/.github/workflows/other.yml@refs/heads/main",
      }),
      githubToken({ event_name: "pull_request" }),
      githubToken({ ref: "refs/pull/1/merge" }),
    ]);

    for (const token of invalid) expect((await issue(["github"], token)).status).toBe(401);
  });

  test("injects only at fixed upstreams and rejects unsafe query, redirect and routes", async () => {
    const issued = await grant([...kinds]);

    for (const kind of ["openai", "anthropic", "openrouter"] as const) {
      const response = await runtime.dispatchFetch(
        `https://broker.test/gateway/${kind}/v1/models`,
        {
          headers: {
            [kind === "anthropic" ? "x-api-key" : "authorization"]:
              kind === "anthropic" ? issued.token : `Bearer ${issued.token}`,
            cookie: "session=must-not-forward",
            "proxy-authorization": "Basic Zm9vOmJhcg==",
            "x-forwarded-host": "evil.invalid",
            "openai-organization": "untrusted-org",
            traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
            baggage: "irrelevant=field",
          },
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ fixture: true });
      const last = seen.at(-1)!;
      expect(last.url.hostname).toBe(kind === "openrouter" ? "openrouter.ai" : `api.${kind}.com`);
      expect(last.url.pathname).toBe(kind === "openrouter" ? "/api/v1/models" : "/v1/models");
      expect(last.headers.get(kind === "anthropic" ? "x-api-key" : "authorization")).toBe(
        kind === "anthropic" ? secret[kind] : `Bearer ${secret[kind]}`,
      );

      for (const name of [
        "cookie",
        "proxy-authorization",
        "x-forwarded-host",
        "openai-organization",
        "traceparent",
        "baggage",
      ]) {
        expect(last.headers.has(name)).toBe(false);
      }

      expect(JSON.stringify([...last.headers])).not.toContain(issued.token);
    }

    const moved = await access("/api/v3/repos/org/moved", issued.token);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/api/v3/repositories/123");
    expect((await access("/api/v3/repos/org/redirect", issued.token)).status).toBe(502);
    expect((await access("/api/v3/user/keys", issued.token)).status).toBe(404);
    expect((await access("/api/v3/user?access_token=placeholder", issued.token)).status).toBe(404);
    expect((await access("/gateway/openrouter/v1/keys", issued.token)).status).toBe(404);

    const beforeWrite = seen.length;

    const blockedWrite = await access(
      "/api/v3/repos/org/demo/issues/99",
      issued.token,
      "PATCH",
      "{}",
    );

    expect(blockedWrite.status).toBe(502);
    expect(seen.slice(beforeWrite).map(({ method, url }) => [method, url.pathname])).toEqual([
      ["PATCH", "/repos/org/demo/issues/99"],
    ]);
  });
});

async function gitHttpBackend(
  url: URL,
  method: string,
  contentType: string | null,
  body: ArrayBuffer,
) {
  const task = Bun.spawn(["git", "http-backend"], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: gitRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      REQUEST_METHOD: method,
      QUERY_STRING: url.search.slice(1),
      CONTENT_LENGTH: String(body.byteLength),
      CONTENT_TYPE: contentType ?? "",
      REMOTE_USER: "fixture",
      REMOTE_ADDR: "127.0.0.1",
    },
    stdin: new Uint8Array(body),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = Buffer.from(await new Response(task.stdout).arrayBuffer());
  const stderr = await new Response(task.stderr).text();
  const exitCode = await task.exited;

  if (exitCode !== 0) throw new Error(`git http-backend fixture failed: ${stderr}`);
  const headerEnd = stdout.indexOf("\r\n\r\n");

  if (headerEnd < 0) throw new Error("git http-backend did not return CGI headers");

  const headers = new Headers();
  let status = 200;

  for (const line of stdout.subarray(0, headerEnd).toString().split("\r\n")) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();

    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value, 10);
    } else {
      headers.append(name, value);
    }
  }

  return new RuntimeResponse(stdout.subarray(headerEnd + 4), { status, headers: [...headers] });
}

async function cli(args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_TELEMETRY: "off",
      GH_PROMPT_DISABLED: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0) throw new Error(`${args[0]} ${args[1]} fixture failed: ${stderr}`);

  return stdout;
}

test("git clone and push use the GitHub smart HTTPS gateway", async () => {
  const root = join(gitRoot, "org");
  await mkdir(root);
  await cli(["git", "init", "--bare", "--initial-branch=main", "demo.git"], root);
  const cert = join(gitRoot, "certificate.pem");
  const key = join(gitRoot, "key.pem");
  await cli(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    gitRoot,
  );

  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    fetch: relayRequest,
  });

  try {
    const issued = await clientGrant(relay.url.origin);
    const remote = "https://github.com/org/demo";
    const gitEnv = { ...issued.env, GIT_SSL_CAINFO: cert };
    await cli(["git", "clone", remote, "work"], gitRoot, gitEnv);
    const checkout = join(gitRoot, "work");
    await Bun.write(join(checkout, "fixture.txt"), "broker git fixture\n");
    await cli(["git", "add", "fixture.txt"], checkout, gitEnv);
    await cli(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "Fixture",
      ],
      checkout,
      gitEnv,
    );
    await cli(["git", "push", "origin", "HEAD:main"], checkout, gitEnv);
    await cli(["git", "clone", remote, "readback"], gitRoot, gitEnv);
    expect(await Bun.file(join(gitRoot, "readback", "fixture.txt")).text()).toBe(
      "broker git fixture\n",
    );
    expect(await cli(["git", "remote", "get-url", "origin"], checkout)).toBe(`${remote}\n`);
  } finally {
    relay.stop(true);
  }
});

test("gh calls GitHub REST and GraphQL through the broker host", async () => {
  const issued = await clientGrant("https://broker.test");
  const ghConfig = join(gitRoot, "gh-config");
  await mkdir(ghConfig);
  const socket = join(gitRoot, "gh.sock");
  await Bun.write(
    join(ghConfig, "config.yml"),
    `http_unix_socket: ${socket}\ntelemetry: disabled\n`,
  );
  const relay = Bun.serve({ unix: socket, fetch: relayRequest });

  const env = {
    ...issued.env,
    GH_CONFIG_DIR: ghConfig,
  };

  try {
    expect(await cli(["gh", "api", "repos/org/demo", "--jq", ".full_name"], gitRoot, env)).toBe(
      "org/demo\n",
    );
    expect(
      await cli(
        [
          "gh",
          "api",
          "repos/org/demo/issues",
          "-X",
          "POST",
          "-f",
          "title=Fixture",
          "--jq",
          ".number",
        ],
        gitRoot,
        env,
      ),
    ).toBe("42\n");
    expect(
      await cli(
        [
          "gh",
          "api",
          "graphql",
          "-f",
          "query=query { viewer { login } }",
          "--jq",
          ".data.viewer.login",
        ],
        gitRoot,
        env,
      ),
    ).toBe("fixture\n");
    expect(
      await cli(
        ["gh", "repo", "view", "org/demo", "--json", "name", "--jq", ".name"],
        gitRoot,
        env,
      ),
    ).toBe("demo\n");
    expect(
      await cli(
        ["gh", "issue", "list", "--repo", "org/demo", "--json", "number", "--jq", ".[0].number"],
        gitRoot,
        env,
      ),
    ).toBe("42\n");
    expect(
      await cli(
        ["gh", "pr", "list", "--repo", "org/demo", "--json", "number", "--jq", ".[0].number"],
        gitRoot,
        env,
      ),
    ).toBe("43\n");
    expect(
      await cli(
        ["gh", "issue", "create", "--repo", "org/demo", "--title", "Fixture", "--body", "Fixture"],
        gitRoot,
        env,
      ),
    ).toBe("https://github.com/org/demo/issues/42\n");
    expect(
      await cli(
        [
          "gh",
          "pr",
          "create",
          "--repo",
          "org/demo",
          "--base",
          "main",
          "--head",
          "feature",
          "--title",
          "Fixture",
          "--body",
          "Fixture",
        ],
        gitRoot,
        env,
      ),
    ).toBe("https://github.com/org/demo/pull/43\n");
    expect(
      await cli(
        ["gh", "pr", "comment", "43", "--repo", "org/demo", "--body", "Fixture"],
        gitRoot,
        env,
      ),
    ).toBe("https://github.com/org/demo/pull/43#issuecomment-1\n");
    expect(
      await cli(
        ["gh", "api", "repos/org/moved/issues", "--paginate", "--jq", ".[].number"],
        gitRoot,
        env,
      ),
    ).toBe("41\n42\n");
    expect(seen.at(-1)?.headers.get("authorization")).toBe(`Bearer ${secret.github}`);
  } finally {
    relay.stop(true);
  }
});

function clientGrant(url: string) {
  const broker = createCredentialBroker({
    url,
    auth: { apiKey },
    fetch: relayRequest,
  });

  return broker.sandbox({ github: "github" }).acquire(new AbortController().signal);
}

async function relayRequest(request: Request): Promise<Response> {
  const response = await runtime.dispatchFetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: request.body ?? undefined,
    redirect: "manual",
  });

  return new Response(response.body, { status: response.status, headers: [...response.headers] });
}

function graphqlFixture(query: string) {
  const typeName = query.match(/(\w+):\s*__type/)?.[1];

  if (typeName)
    return RuntimeResponse.json({
      data: { [typeName]: { fields: [{ name: "number" }, { name: "id" }, { name: "url" }] } },
    });
  const issue = { id: "ISSUE_42", number: 42, url: "https://github.com/org/demo/issues/42" };
  const pull = { id: "PR_43", number: 43, url: "https://github.com/org/demo/pull/43" };
  const pageInfo = { hasNextPage: false, endCursor: null };

  const repository = {
    id: "REPO_DEMO",
    name: "demo",
    nameWithOwner: "org/demo",
    url: "https://github.com/org/demo",
    owner: { login: "org" },
    viewerPermission: "WRITE",
    hasIssuesEnabled: true,
    defaultBranchRef: { name: "main" },
    issues: { nodes: [issue], totalCount: 1, pageInfo },
    pullRequests: { nodes: [pull], totalCount: 1, pageInfo },
    issue,
    pullRequest: pull,
  };

  if (query.includes("mutation") && query.includes("createIssue")) {
    return RuntimeResponse.json({ data: { createIssue: { issue: { url: issue.url } } } });
  }

  if (query.includes("mutation") && query.includes("createPullRequest")) {
    return RuntimeResponse.json({ data: { createPullRequest: { pullRequest: pull } } });
  }

  if (query.includes("mutation") && query.includes("addComment")) {
    return RuntimeResponse.json({
      data: { addComment: { commentEdge: { node: { url: `${pull.url}#issuecomment-1` } } } },
    });
  }

  if (!query.includes("repository") && !query.includes("search")) {
    return RuntimeResponse.json({ data: { viewer: { login: "fixture" } } });
  }

  return RuntimeResponse.json({
    data: {
      repository,
      viewer: { login: "fixture" },
      search: {
        nodes: query.includes("PullRequest") ? [pull] : [issue],
        issueCount: 1,
        pageInfo,
      },
    },
  });
}

function startRuntime(state = "state") {
  return new Miniflare({
    ...convertV4MiniflareOptions(options),
    resourcePersistencePath: join(gitRoot, state),
  });
}

function sseFixture() {
  const encoder = new TextEncoder();

  return new RuntimeResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"first":true}\n\n'));
        sendStreamTail = () => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("streams data before completion and reclaims concurrency leases", async () => {
  const issued = await grant(["openai"]);
  const path = "/gateway/openai/v1/chat/completions";
  const body = JSON.stringify({ model: "fixture", stream: true });
  const requests = [];

  try {
    for (let index = 0; index < 8; index++) {
      const pending = await access(path, issued.token, "POST", body);
      expect(pending.status).toBe(200);
      expect(pending.headers.get("content-type")).toBe("text/event-stream");
      requests.push({ pending, finish: sendStreamTail! });
    }

    const rejected = await access(path, issued.token, "POST", body);
    expect(rejected.status).toBe(429);

    const { pending: first, finish } = requests.shift()!;
    const reader = first.body!.getReader();
    const head = await reader.read();
    expect(new TextDecoder().decode(head.value)).toBe('data: {"first":true}\n\n');
    finish();
    const tail = await reader.read();
    expect(new TextDecoder().decode(tail.value)).toBe("data: [DONE]\n\n");
    expect((await reader.read()).done).toBe(true);
    expect(seen.at(-1)?.body).toBe(body);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] = await storage.exec(
        "SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?",
        issued.id,
      );

      if (row.count === 7) break;
      await Bun.sleep(20);
    }

    expect(
      await storage.exec("SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?", issued.id),
    ).toEqual([{ count: 7 }]);
    expect((await access(`/v1/grants/${issued.id}`, apiKey, "DELETE")).status).toBe(204);
    expect((await access(path, issued.token, "POST", body)).status).toBe(401);
    expect(
      await storage.exec("SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?", issued.id),
    ).toEqual([{ count: 0 }]);
  } finally {
    for (const { pending, finish } of requests) {
      finish();
      await pending.text();
    }
  }
});

test("retains grants and request limits across restart and applies the bundled migration once", async () => {
  const original = runtime;
  runtime = startRuntime("restart-fixture");

  try {
    const record = await grant(["openai"]);

    const previousStorage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    const remainingInMinute = 60_000 - (Date.now() % 60_000);

    if (remainingInMinute < 2_000) await Bun.sleep(remainingInMinute + 20);

    const window = Math.floor(Date.now() / 60_000);
    await previousStorage.exec(
      "UPDATE grants SET rate_count = 119, rate_window = ? WHERE id = ?",
      window,
      record.id,
    );

    await runtime.dispose();
    runtime = startRuntime("restart-fixture");

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    expect(await storage.exec("SELECT COUNT(*) AS count FROM __drizzle_migrations")).toEqual([
      { count: 1 },
    ]);

    const path = "/gateway/openai/v1/models";
    const response = await access(path, record.token);
    expect(response.status).toBe(200);
    await response.text();
    expect(await storage.exec("SELECT rate_count FROM grants WHERE id = ?", record.id)).toEqual([
      { rate_count: 120 },
    ]);

    const forwarded = seen.length;
    expect((await access(path, record.token)).status).toBe(429);
    expect(seen.length).toBe(forwarded);

    // Simulate a counter from the previous minute without waiting for wall-clock rollover.
    await storage.exec("UPDATE grants SET rate_window = ? WHERE id = ?", window - 1, record.id);
    const allowed = await access(path, record.token);
    expect(allowed.status).toBe(200);
    await allowed.text();
    expect(await storage.exec("SELECT rate_count FROM grants WHERE id = ?", record.id)).toEqual([
      { rate_count: 1 },
    ]);
  } finally {
    await runtime.dispose();
    runtime = original;
  }
}, 15_000);

test("admission enforces per-owner and deployment-wide active grant bounds", async () => {
  const original = runtime;
  runtime = startRuntime("capacity-fixture");

  try {
    await grant(["openai"]);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    const expiresAt = Date.now() + 60_000;

    const seed = `
    WITH RECURSIVE sample(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sample WHERE n < ?)
    INSERT INTO grants (id, hash, owner, permissions, expires_at)
    SELECT ? || n, ? || n, `;

    await storage.exec(
      `${seed} 'broker-api-key', '[]', ? FROM sample`,
      98,
      "owner:",
      "owner:",
      expiresAt,
    );

    await grant(["openai"]);
    expect((await issue(["openai"])).status).toBe(429);

    await storage.exec(
      `${seed} 'fixture-owner:' || n, '[]', ? FROM sample`,
      899,
      "global:",
      "global:",
      expiresAt,
    );
    const authority = await githubToken();
    await grant(["github"], authority);
    expect((await issue(["github"], await githubToken({ run_id: "301" }))).status).toBe(429);
  } finally {
    await runtime.dispose();
    runtime = original;
  }
}, 15_000);
