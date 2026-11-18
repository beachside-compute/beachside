import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { ListenOptions, Server } from "node:net";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import type { V4MiniflareOptions } from "miniflare";
import { z } from "zod";
import { createCredentialBroker } from "../../../packages/credential-client/src/index";
import { isBrokerApiKey, matchesKey } from "../src/auth/api-key";
import { parseConfig } from "../src/config";
import { workerSecretSource } from "../src/credentials/sources/worker-secret";
import { tokenHash } from "../src/grants/tokens";

const execute = promisify(execFile);

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

const reusablePolicy = {
  ...policy,
  event: "workflow_dispatch",
  jobWorkflowRef: "beachside-compute/automation/.github/workflows/shared.yml@refs/heads/main",
};

const config = {
  integrations: kinds.map((kind) => ({
    kind,
    id: kind,
    credential: { source: "worker-secret", binding: `CREDENTIAL_${kind.toUpperCase()}` },
  })),
  githubActions: { audience, workflows: [policy, reusablePolicy] },
};

const claims = {
  repository_id: policy.repositoryId,
  repository_owner_id: policy.repositoryOwnerId,
  repository: policy.repository,
  ref: policy.ref,
  workflow_ref: policy.workflowRef,
  job_workflow_ref: policy.workflowRef,
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
    entryPoints: [`${import.meta.dirname}/../../src/index.ts`],
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
      assert.equal(
        request.headers.get("authorization"),
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

before(async () => {
  gitRoot = await mkdtemp(join(tmpdir(), "beachside-broker-"));
  runtime = startRuntime();
});

after(async () => {
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
  assert.equal(response.status, 201);

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
    assert.equal((await issue(["openai"], "wrong-key")).status, 401);
    assert.equal((await issue(["openai"], "z".repeat(32))).status, 401);
    assert.equal((await issue(["unknown"])).status, 403);
    assert.equal((await issue(["openai", "openai"])).status, 400);
    assert.equal((await issue(["openai"], apiKey, 3601)).status, 400);

    const record = await grant(["openai"]);
    assert.equal((await issue(["openai"], record.token)).status, 401);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    const stored = await storage.exec("SELECT * FROM grants WHERE id = ?", record.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].hash, await tokenHash(record.token));
    assert.ok(!JSON.stringify(stored).includes(record.token));

    for (const value of Object.values(secret)) assert.ok(!JSON.stringify(stored).includes(value));

    await runtime.unsafeEvictDurableObject("broker", "GrantRegistry", { name: "grant-registry" });
    const response = await access("/gateway/openai/v1/models", record.token);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal((await access("/gateway/openrouter/v1/models", record.token)).status, 403);

    const deniedRevoke = await access(`/v1/grants/${record.id}`, record.token, "DELETE");
    assert.equal(deniedRevoke.status, 401);
    assert.equal((await access(`/v1/grants/${record.id}`, apiKey, "DELETE")).status, 204);
    assert.equal((await access(`/v1/grants/${record.id}`, apiKey, "DELETE")).status, 204);
    assert.equal((await access("/gateway/openai/v1/models", record.token)).status, 401);
    assert.deepEqual(await storage.exec("SELECT id FROM leases WHERE grant_id = ?", record.id), []);

    const expiring = await grant(["openai"], apiKey, 1);
    const expiresIn = Date.parse(expiring.expiresAt) - Date.now();
    await delay(Math.max(0, expiresIn) + 20);
    assert.equal((await access("/gateway/openai/v1/models", expiring.token)).status, 401);

    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = await storage.exec("SELECT id FROM grants WHERE id = ?", expiring.id);

      if (!rows.length) break;
      await delay(20);
    }

    assert.deepEqual(await storage.exec("SELECT id FROM grants WHERE id = ?", expiring.id), []);
  });

  test("verifies GitHub Actions signature and direct-workflow claims through the JWKS endpoint", async () => {
    const authority = await githubToken();
    const record = await grant(["github"], authority);
    await grant(["github"], await githubToken({ job_workflow_ref: undefined }));
    assert.equal((await issue(["openai"], authority)).status, 403);
    const otherRun = await githubToken({ run_id: "301" });
    assert.equal((await access(`/v1/grants/${record.id}`, otherRun, "DELETE")).status, 204);
    const response = await access("/api/v3/user", record.token);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal((await access(`/v1/grants/${record.id}`, authority, "DELETE")).status, 204);

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
      githubToken({ job_workflow_ref: reusablePolicy.jobWorkflowRef }),
      githubToken({ event_name: "pull_request" }),
      githubToken({ ref: "refs/pull/1/merge" }),
    ]);

    for (const token of invalid) assert.equal((await issue(["github"], token)).status, 401);
  });

  test("requires an exact signed job_workflow_ref for a configured reusable workflow", async () => {
    const event = { event_name: reusablePolicy.event };

    const authority = await githubToken({
      ...event,
      job_workflow_ref: reusablePolicy.jobWorkflowRef,
    });

    await grant(["github"], authority);

    for (const ref of [undefined, policy.workflowRef, `${reusablePolicy.jobWorkflowRef}-wrong`]) {
      const wrong = await githubToken({ ...event, job_workflow_ref: ref });
      assert.equal((await issue(["github"], wrong)).status, 401);
    }
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

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { fixture: true });
      const last = seen.at(-1)!;
      assert.equal(last.url.hostname, kind === "openrouter" ? "openrouter.ai" : `api.${kind}.com`);
      assert.equal(last.url.pathname, kind === "openrouter" ? "/api/v1/models" : "/v1/models");
      assert.equal(
        last.headers.get(kind === "anthropic" ? "x-api-key" : "authorization"),
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
        assert.equal(last.headers.has(name), false);
      }

      assert.ok(!JSON.stringify([...last.headers]).includes(issued.token));
    }

    const moved = await access("/api/v3/repos/org/moved", issued.token);
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get("location"), "/api/v3/repositories/123");
    assert.equal((await access("/api/v3/repos/org/redirect", issued.token)).status, 502);
    assert.equal((await access("/api/v3/user/keys", issued.token)).status, 404);
    assert.equal((await access("/api/v3/user?access_token=placeholder", issued.token)).status, 404);
    assert.equal((await access("/gateway/openrouter/v1/keys", issued.token)).status, 404);

    const beforeRef = seen.length;

    for (const endpoint of ["branches", "commits"]) {
      for (const ref of ["feature/login", "feature%2Flogin"]) {
        assert.equal(
          (await access(`/api/v3/repos/org/demo/${endpoint}/${ref}`, issued.token)).status,
          404,
        );
      }
    }

    assert.equal(seen.length, beforeRef);

    const beforeWrite = seen.length;

    const blockedWrite = await access(
      "/api/v3/repos/org/demo/issues/99",
      issued.token,
      "PATCH",
      "{}",
    );

    assert.equal(blockedWrite.status, 502);
    assert.deepEqual(
      seen.slice(beforeWrite).map(({ method, url }) => [method, url.pathname]),
      [["PATCH", "/repos/org/demo/issues/99"]],
    );
  });
});

test("reserves the grant-token format outside the broker API-key parser", async () => {
  const reserved = `bsg_${"0".repeat(64)}`;
  assert.equal(isBrokerApiKey(apiKey), true);
  assert.equal(isBrokerApiKey(reserved), false);
  assert.equal(await matchesKey(reserved, reserved), false);
});

test("reuses only the last validated operator configuration", () => {
  const raw = JSON.stringify(config);
  const original = parseConfig(raw);
  assert.equal(parseConfig(raw), original);

  const changedRaw = JSON.stringify({
    ...config,
    githubActions: { ...config.githubActions, audience: "new-audience" },
  });

  const changed = parseConfig(changedRaw);
  assert.equal(changed.githubActions?.audience, "new-audience");
  assert.throws(
    () => parseConfig(JSON.stringify({ integrations: [] })),
    /Invalid broker configuration/,
  );
  assert.equal(parseConfig(changedRaw), changed);
  assert.notEqual(parseConfig(raw), original);
});

test("reads Worker secret data properties and getters and rejects unavailable bindings", async () => {
  const reference = { source: "worker-secret", binding: "CREDENTIAL_MODEL" } as const;
  const plain = workerSecretSource({ CREDENTIAL_MODEL: "plain-fixture-value" });
  assert.deepEqual(await plain.resolve(reference), { value: "plain-fixture-value" });

  let value = "first-fixture-value";

  const getter = workerSecretSource({
    get CREDENTIAL_MODEL() {
      return value;
    },
  });

  assert.deepEqual(await getter.resolve(reference), { value });

  value = "rotated-fixture-value";
  assert.deepEqual(await getter.resolve(reference), { value });
  assert.equal(await workerSecretSource({}).resolve(reference), undefined);
  assert.equal(
    await workerSecretSource({ CREDENTIAL_MODEL: "invalid\nvalue" }).resolve(reference),
    undefined,
  );
});

async function gitHttpBackend(
  url: URL,
  method: string,
  contentType: string | null,
  body: ArrayBuffer,
) {
  const task = spawn("git", ["http-backend"], {
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
    stdio: ["pipe", "pipe", "pipe"],
  });

  const completion = once(task, "close");
  task.stdin.end(Buffer.from(body));

  const [output, stderr, [exitCode]] = await Promise.all([
    buffer(task.stdout),
    buffer(task.stderr),
    completion,
  ]);

  if (exitCode !== 0) throw new Error(`git http-backend fixture failed: ${stderr}`);
  const stdout = Buffer.from(output);
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
  const [command, ...parameters] = args;

  const { stdout } = await execute(command, parameters, {
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
  });

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

  const relay = createHttpsServer(
    { cert: await readFile(cert), key: await readFile(key) },
    relayHttp,
  );

  await listen(relay, { host: "127.0.0.1", port: 0 });

  try {
    const { port } = z.object({ port: z.number() }).parse(relay.address());
    const issued = await clientGrant(`https://127.0.0.1:${port}`);
    const remote = "https://github.com/org/demo";
    const gitEnv = { ...issued.env, GIT_SSL_CAINFO: cert };
    await cli(["git", "clone", remote, "work"], gitRoot, gitEnv);
    const checkout = join(gitRoot, "work");
    await writeFile(join(checkout, "fixture.txt"), "broker git fixture\n");
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
    assert.equal(
      await readFile(join(gitRoot, "readback", "fixture.txt"), "utf8"),
      "broker git fixture\n",
    );
    assert.equal(await cli(["git", "remote", "get-url", "origin"], checkout), `${remote}\n`);
  } finally {
    await relay[Symbol.asyncDispose]();
  }
});

test("gh calls GitHub REST and GraphQL through the broker host", async () => {
  const issued = await clientGrant("https://broker.test");
  const ghConfig = join(gitRoot, "gh-config");
  await mkdir(ghConfig);
  const socket = join(gitRoot, "gh.sock");
  await writeFile(
    join(ghConfig, "config.yml"),
    `http_unix_socket: ${socket}\ntelemetry: disabled\n`,
  );
  const relay = createServer(relayHttp);
  await listen(relay, { path: socket });

  const env = {
    ...issued.env,
    GH_CONFIG_DIR: ghConfig,
  };

  try {
    assert.equal(
      await cli(["gh", "api", "repos/org/demo", "--jq", ".full_name"], gitRoot, env),
      "org/demo\n",
    );
    assert.equal(
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
      "42\n",
    );
    assert.equal(
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
      "fixture\n",
    );
    assert.equal(
      await cli(
        ["gh", "repo", "view", "org/demo", "--json", "name", "--jq", ".name"],
        gitRoot,
        env,
      ),
      "demo\n",
    );
    assert.equal(
      await cli(
        ["gh", "issue", "list", "--repo", "org/demo", "--json", "number", "--jq", ".[0].number"],
        gitRoot,
        env,
      ),
      "42\n",
    );
    assert.equal(
      await cli(
        ["gh", "pr", "list", "--repo", "org/demo", "--json", "number", "--jq", ".[0].number"],
        gitRoot,
        env,
      ),
      "43\n",
    );
    assert.equal(
      await cli(
        ["gh", "issue", "create", "--repo", "org/demo", "--title", "Fixture", "--body", "Fixture"],
        gitRoot,
        env,
      ),
      "https://github.com/org/demo/issues/42\n",
    );
    assert.equal(
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
      "https://github.com/org/demo/pull/43\n",
    );
    assert.equal(
      await cli(
        ["gh", "pr", "comment", "43", "--repo", "org/demo", "--body", "Fixture"],
        gitRoot,
        env,
      ),
      "https://github.com/org/demo/pull/43#issuecomment-1\n",
    );
    assert.equal(
      await cli(
        ["gh", "api", "repos/org/moved/issues", "--paginate", "--jq", ".[].number"],
        gitRoot,
        env,
      ),
      "41\n42\n",
    );
    assert.equal(seen.at(-1)?.headers.get("authorization"), `Bearer ${secret.github}`);
  } finally {
    await relay[Symbol.asyncDispose]();
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
    body: request.body ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });

  return new Response(response.body, { status: response.status, headers: [...response.headers] });
}

async function relayHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url!, `https://${request.headers.host}`);
    const headers: [string, string][] = [];

    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      headers.push([request.rawHeaders[index], request.rawHeaders[index + 1]]);
    }

    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await buffer(request);

    const result = await runtime.dispatchFetch(url.href, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });

    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined);
  }
}

async function listen(server: Server, options: ListenOptions): Promise<void> {
  server.listen(options);
  await once(server, "listening");
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
      assert.equal(pending.status, 200);
      assert.equal(pending.headers.get("content-type"), "text/event-stream");
      requests.push({ pending, finish: sendStreamTail! });
    }

    const rejected = await access(path, issued.token, "POST", body);
    assert.equal(rejected.status, 429);

    const { pending: first, finish } = requests.shift()!;
    const reader = first.body!.getReader();
    const head = await reader.read();
    assert.equal(new TextDecoder().decode(head.value), 'data: {"first":true}\n\n');
    finish();
    const tail = await reader.read();
    assert.equal(new TextDecoder().decode(tail.value), "data: [DONE]\n\n");
    assert.equal((await reader.read()).done, true);
    assert.equal(seen.at(-1)?.body, body);

    const storage = await runtime.unsafeGetDurableObjectStorage("broker", "GrantRegistry", {
      name: "grant-registry",
    });

    for (let attempt = 0; attempt < 40; attempt++) {
      const [row] = await storage.exec(
        "SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?",
        issued.id,
      );

      if (row.count === 7) break;
      await delay(20);
    }

    assert.deepEqual(
      await storage.exec("SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?", issued.id),
      [{ count: 7 }],
    );
    assert.equal((await access(`/v1/grants/${issued.id}`, apiKey, "DELETE")).status, 204);
    assert.equal((await access(path, issued.token, "POST", body)).status, 401);
    assert.deepEqual(
      await storage.exec("SELECT COUNT(*) AS count FROM leases WHERE grant_id = ?", issued.id),
      [{ count: 0 }],
    );
  } finally {
    for (const { pending, finish } of requests) {
      finish();
      await pending.text();
    }
  }
});

test(
  "retains grants and request limits across restart and applies the bundled migration once",
  { timeout: 15_000 },
  async () => {
    const original = runtime;
    runtime = startRuntime("restart-fixture");

    try {
      const record = await grant(["openai"]);

      const previousStorage = await runtime.unsafeGetDurableObjectStorage(
        "broker",
        "GrantRegistry",
        {
          name: "grant-registry",
        },
      );

      const remainingInMinute = 60_000 - (Date.now() % 60_000);

      if (remainingInMinute < 2_000) await delay(remainingInMinute + 20);

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

      assert.deepEqual(await storage.exec("SELECT COUNT(*) AS count FROM __drizzle_migrations"), [
        { count: 1 },
      ]);

      const path = "/gateway/openai/v1/models";
      const response = await access(path, record.token);
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(
        await storage.exec("SELECT rate_count FROM grants WHERE id = ?", record.id),
        [{ rate_count: 120 }],
      );

      const forwarded = seen.length;
      assert.equal((await access(path, record.token)).status, 429);
      assert.equal(seen.length, forwarded);

      // Simulate a counter from the previous minute without waiting for wall-clock rollover.
      await storage.exec("UPDATE grants SET rate_window = ? WHERE id = ?", window - 1, record.id);
      const allowed = await access(path, record.token);
      assert.equal(allowed.status, 200);
      await allowed.text();
      assert.deepEqual(
        await storage.exec("SELECT rate_count FROM grants WHERE id = ?", record.id),
        [{ rate_count: 1 }],
      );
    } finally {
      await runtime.dispose();
      runtime = original;
    }
  },
);

test(
  "admission enforces per-owner and deployment-wide active grant bounds",
  { timeout: 15_000 },
  async () => {
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
      assert.equal((await issue(["openai"])).status, 429);

      await storage.exec(
        `${seed} 'fixture-owner:' || n, '[]', ? FROM sample`,
        899,
        "global:",
        "global:",
        expiresAt,
      );
      const authority = await githubToken();
      await grant(["github"], authority);
      assert.equal((await issue(["github"], await githubToken({ run_id: "301" }))).status, 429);
    } finally {
      await runtime.dispose();
      runtime = original;
    }
  },
);
