import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";

const token = "local-test-token-12345";
const issuerKey = "fixture-issuer-key-0123456789abcdef";
const adminKey = "fixture-admin-key-0123456789abcdefg";
const grantToken = `bsg_${"a".repeat(64)}`;
const grantId = "de07c688-48d2-4073-bb20-c6e5c2893f19";
const main = join(import.meta.dir, "..", "src", "main.ts");
const fixture = join(import.meta.dir, "fake-adapter.ts");

let root: string;
let dir: string;
let provider: Awaited<ReturnType<typeof startFakeProviderServer>>;
let broker: ReturnType<typeof Bun.serve>;

/** Every request the fake broker saw: method, path, key and JSON body. */
const calls: { method: string; path: string; key: string | null; body: unknown }[] = [];

const kinds = { claude: "anthropic", gh: "github", api: "http" } as const;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "beachside-broker-")));
  provider = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(root, "fake.json"),
    token,
    testMode: true,
  });

  broker = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      calls.push({ method: request.method, path: pathname, key, body });

      if (key !== issuerKey && key !== adminKey)
        return Response.json({ error: "unauthenticated" }, { status: 401 });

      if (pathname === "/v1/status")
        return Response.json({
          apiVersion: 2,
          role: key === adminKey ? "admin" : "issuer",
          limits: { maxGrantTtlSeconds: 604_800 },
        });

      if (pathname === "/v1/grants" && request.method === "POST") {
        // SAFETY: the CLI under test sends this body; a wrong shape fails the assertions below.
        const { integrations } = body as { integrations: string[] };

        if (integrations.includes("blocked"))
          return Response.json(
            {
              error: "integration_forbidden",
              reason: "not_allowlisted",
              integrations: ["blocked"],
            },
            { status: 403 },
          );

        return Response.json(
          {
            id: grantId,
            token: grantToken,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            integrations,
            kinds,
          },
          { status: 201 },
        );
      }

      if (pathname === `/v1/grants/${grantId}/renew`)
        return Response.json({
          id: grantId,
          integrations: ["claude"],
          label: null,
          createdAt: null,
          expiresAt: "2030-01-01T00:00:00.000Z",
          requests: 0,
          lastUsedAt: null,
        });

      if (pathname === `/v1/grants/${grantId}` && request.method === "DELETE")
        return new Response(null, { status: 204 });

      if (pathname === "/v1/grants") return Response.json({ grants: [] });

      if (pathname === "/v1/admin/integrations" && request.method === "POST")
        return Response.json(
          {
            id: "api",
            kind: "http",
            enabled: true,
            endpoint: { baseURL: "https://api.example.com", headers: [] },
            credentialSource: "encrypted-store",
            credentialVersion: 1,
            createdAt: "2026-11-20T00:00:00.000Z",
            updatedAt: "2026-11-20T00:00:00.000Z",
            issuable: false,
          },
          { status: 201 },
        );

      if (pathname === "/v1/admin/issuer-permissions/api" && request.method === "PUT")
        return Response.json({ integrations: ["api"] });

      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  await provider.stop(true);
  await broker.stop(true);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  calls.length = 0;
  await fetch(new URL("/_test/reset", provider.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  dir = await mkdtemp(join(root, "case-"));
  await writeFile(
    join(dir, "beachside.json"),
    JSON.stringify({ default: "fake", profiles: { fake: { module: fixture, export: "fake" } } }),
  );
});

async function cli(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const child = Bun.spawn(["bun", main, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      BEACHSIDE_TELEMETRY: "0",
      HOME: dir,
      BEACHSIDE_CONFIG: join(dir, "beachside.json"),
      BEACHSIDE_STATE_DIR: join(dir, "state"),
      BEACHSIDE_FAKE_URL: provider.url.origin,
      BEACHSIDE_FAKE_TOKEN: token,
      NO_PROXY: "127.0.0.1,localhost",
      ...env,
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // Keys and the grant token never reach the terminal.
  for (const secret of [issuerKey, adminKey, grantToken]) {
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  }

  return { code, stdout, stderr };
}

async function sandboxEnv(): Promise<Record<string, string>> {
  const response = await fetch(new URL("/_test/state", provider.url), {
    headers: { Authorization: `Bearer ${token}` },
  });

  // SAFETY: the fake provider's test state endpoint returns this shape.
  const { resources } = (await response.json()) as {
    resources: { state: string; env?: Record<string, string> }[];
  };

  return resources.find((resource) => resource.state === "running")?.env ?? {};
}

test("broker add checks each key's role and saves references, never the value of a reference", async () => {
  const origin = broker.url.origin;
  const env = { BROKER_ISSUER: issuerKey };

  const swapped = await cli(
    ["broker", "add", "work", "--url", origin, "--issuer-key", "env:BROKER_ADMIN"],
    { BROKER_ADMIN: adminKey },
  );

  expect(swapped.code).toBe(2);
  expect(swapped.stderr).toContain("--issuer-key is the broker's admin key");

  const added = await cli(
    ["broker", "add", "work", "--url", origin, "--issuer-key", "env:BROKER_ISSUER"],
    env,
  );

  expect(added.code, added.stderr).toBe(0);
  expect(added.stdout).toContain("added broker work");
  expect(added.stdout).toContain("as the default");
  const config = JSON.parse(await readFile(join(dir, "beachside.json"), "utf8"));
  expect(config.brokers).toEqual({ work: { url: origin, issuerKey: "env:BROKER_ISSUER" } });
  expect(config.defaultBroker).toBe("work");

  const listed = await cli(["broker", "ls", "--json"]);
  expect(JSON.parse(listed.stdout).data.brokers).toEqual([
    { name: "work", url: origin, default: true, issuerKey: true, adminKey: false },
  ]);

  const piped = await cli(
    ["broker", "add", "spare", "--url", origin, "--admin-key", "-"],
    {},
    adminKey,
  );

  expect(piped.code, piped.stderr).toBe(0);
  expect(piped.stdout).toContain("readable only by you");
  expect((await stat(join(dir, "beachside.json"))).mode & 0o777).toBe(0o600);

  const deployment = join(dir, ".env.deploy");
  const settings = `BEACHSIDE_BROKER_URL=${origin}\nBROKER_ADMIN_KEY=${adminKey}\nBROKER_ISSUER_KEY=${issuerKey}\n`;
  await writeFile(deployment, settings, { mode: 0o644 });
  const exposed = await cli(["broker", "add", "main", "--deployment", deployment]);
  expect(exposed.code).toBe(2);
  expect(exposed.stderr).toContain("readable by other users");
  await chmod(deployment, 0o600);
  const fromFile = await cli(["broker", "add", "main", "--deployment", deployment]);
  expect(fromFile.code, fromFile.stderr).toBe(0);
  expect(fromFile.stdout).toContain("issuer key ok, admin key ok");

  const endpoint = JSON.stringify({
    endpoint: { baseURL: "https://api.example.com", headers: [] },
    credential: { source: "encrypted-store", values: {} },
  });

  // --provider belongs to the broker command here, not to the CLI's profile selection.
  const integration = await cli(
    [
      "broker",
      "integration",
      "create",
      "api",
      "--provider",
      "http",
      "--config-stdin",
      "--allow-issue",
      "--broker",
      "spare",
    ],
    {},
    endpoint,
  );

  expect(integration.code, integration.stderr).toBe(0);
  expect(calls.find((call) => call.path === "/v1/admin/integrations")).toMatchObject({
    key: adminKey,
    body: { id: "api", kind: "http" },
  });

  const elsewhere = await cli([
    "broker",
    "status",
    "--broker",
    "spare",
    "--url",
    "https://example.com",
  ]);

  expect(elsewhere.code).toBe(2);
  expect(elsewhere.stderr).toContain("--url applies only to `beachside broker add`");

  const status = await cli(["broker", "status", "--broker", "spare", "--json"]);
  expect(status.code, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, data: { role: "admin" } });
});

test("create --grant puts the grant in the sandbox env, records it, renews it by sandbox name and revokes it on rm", async () => {
  const env = { BROKER_ISSUER: issuerKey };

  await cli([
    "broker",
    "add",
    "work",
    "--url",
    broker.url.origin,
    "--issuer-key",
    "env:BROKER_ISSUER",
    "--no-check",
  ]);

  const blocked = await cli(
    ["create", "--name", "a", "--grant", "claude", "--network", "blocked"],
    env,
  );

  expect(blocked.code).toBe(2);
  expect(blocked.stderr).toContain("--grant needs a network");

  const created = await cli(
    [
      "create",
      "--name",
      "agent",
      "--prepared",
      "fake-starter",
      "--grant",
      "claude",
      "--grant",
      "api=API_BASE,API_TOKEN",
      "--grant-ttl",
      "7d",
      "--json",
    ],
    env,
  );

  expect(created.code, created.stdout).toBe(0);
  expect(calls.find((call) => call.path === "/v1/grants")?.body).toEqual({
    integrations: ["claude", "api"],
    ttlSeconds: 604_800,
    label: "beachside agent",
  });

  const sandbox = await sandboxEnv();
  expect(sandbox).toMatchObject({
    ANTHROPIC_BASE_URL: `${broker.url.origin}/gateway/claude`,
    ANTHROPIC_API_KEY: grantToken,
    API_BASE: `${broker.url.origin}/gateway/api`,
    API_TOKEN: grantToken,
  });

  const record = JSON.parse(await readFile(join(dir, "state", "sandboxes", "agent.json"), "utf8"));
  expect(record.grant).toMatchObject({
    broker: "work",
    url: broker.url.origin,
    id: grantId,
    env: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "API_BASE", "API_TOKEN"],
  });
  expect(JSON.stringify(record)).not.toContain(grantToken);

  const inspected = await cli(["inspect", "agent"], env);
  expect(inspected.stdout).toContain("grant     claude, api via work");

  const renewed = await cli(["broker", "grant", "renew", "agent", "--ttl", "7d"], env);
  expect(renewed.code, renewed.stderr).toBe(0);
  expect(renewed.stdout).toContain("expires 2030-01-01T00:00:00.000Z");
  expect(calls.at(-1)).toMatchObject({
    path: `/v1/grants/${grantId}/renew`,
    body: { ttlSeconds: 604_800 },
  });

  const removed = await cli(["rm", "agent"], env);
  expect(removed.code, removed.stderr).toBe(0);
  expect(calls.at(-1)).toMatchObject({
    method: "DELETE",
    path: `/v1/grants/${grantId}`,
    key: issuerKey,
  });
});

test("a refused grant names the fix and leaves nothing behind", async () => {
  const env = {
    BEACHSIDE_BROKER_URL: broker.url.origin,
    BEACHSIDE_BROKER_ISSUER_KEY: issuerKey,
  };

  const refused = await cli(["create", "--name", "agent", "--grant", "blocked"], env);

  expect(refused.code).toBe(5);
  expect(refused.stderr).toContain("Integration blocked is not allowed to issue grants");
  expect(refused.stderr).toContain("beachside broker issuer allow blocked");
  expect(await sandboxEnv()).toEqual({});

  const missing = await cli(["create", "--grant", "claude"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("No credential broker is set up");
  expect(missing.stderr).toContain("beachside broker add");

  for (const [args, message] of [
    [["create", "--grant", "claude", "--cache"], "--grant cannot be combined with --cache"],
    [["create", "--grant", `a${"b".repeat(32)}`], "Invalid --grant"],
    [
      ["broker", "add", "x", "--url", "http://example.com", "--issuer-key", "k", "--no-check"],
      "not an HTTPS origin",
    ],
  ] as const) {
    const refusedLocally = await cli([...args], env);
    expect(refusedLocally.code).toBe(2);
    expect(refusedLocally.stderr).toContain(message);
  }

  const invalid = await cli(["create", "--grant", "claude", "--grant-ttl", "8d"], env);
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain("at most 7d");
});

test("--grant on a provider without sandbox-wide env refuses before asking the broker", async () => {
  await writeFile(
    join(dir, "beachside.json"),
    JSON.stringify({
      default: "noenv",
      profiles: { noenv: { module: fixture, export: "withoutCreateEnv" } },
    }),
  );

  const env = { BEACHSIDE_BROKER_URL: broker.url.origin, BEACHSIDE_BROKER_ISSUER_KEY: issuerKey };
  const refused = await cli(["create", "--name", "agent", "--grant", "claude"], env);

  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("--grant needs sandbox-wide env");
  expect(calls.filter((call) => call.path === "/v1/grants")).toEqual([]);
  expect(await sandboxEnv()).toEqual({});
});

test("broker add creates a --config file that does not exist yet", async () => {
  const fresh = join(dir, "new", "beachside.json");

  const added = await cli(
    ["broker", "add", "work", "--url", broker.url.origin, "--issuer-key", "env:K", "--no-check"],
    { BEACHSIDE_CONFIG: fresh },
  );

  expect(added.code).toBe(0);
  expect(JSON.parse(await readFile(fresh, "utf8")).brokers.work).toMatchObject({
    url: broker.url.origin,
  });
  expect((await stat(fresh)).mode & 0o777).toBe(0o600);
});
