import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";

const token = "local-test-token-12345";
const boardToken = `bbr_${"x".repeat(43)}`;
const main = join(import.meta.dir, "..", "src", "main.ts");
const fixture = join(import.meta.dir, "fake-adapter.ts");
const beachbar = join(import.meta.dir, "fake-beachbar.ts");

let root: string;
let dir: string;
let provider: Awaited<ReturnType<typeof startFakeProviderServer>>;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "beachside-board-")));
  provider = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(root, "fake.json"),
    token,
    testMode: true,
  });
});

afterAll(async () => {
  await provider.stop(true);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
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

async function cli(args: string[], env: Record<string, string> = {}) {
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
      BEACHSIDE_BEACHBAR: beachbar,
      FAKE_BEACHBAR_LOG: join(dir, "beachbar.log"),
      NO_PROXY: "127.0.0.1,localhost",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // The board token never reaches the terminal.
  expect(stdout).not.toContain(boardToken);
  expect(stderr).not.toContain(boardToken);

  return { code, stdout, stderr };
}

async function beachbarCalls(): Promise<string[][]> {
  const text = await readFile(join(dir, "beachbar.log"), "utf8").catch(() => "");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
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

test("board passes its arguments to beachbar, with board words under `board`", async () => {
  const created = await cli(["board", "create", "fix-auth"]);

  expect(created.code, created.stderr).toBe(0);
  expect(created.stdout).toBe("beachbar board create fix-auth\n");

  const task = await cli([
    "board",
    "task",
    "add",
    "Add a limiter",
    "--board",
    "fix-auth",
    "--json",
  ]);

  expect(task.stdout).toBe("beachbar --json task add Add a limiter --board fix-auth\n");
  expect((await cli(["board", "fail"])).code).toBe(4);
  expect((await cli(["board"])).stdout).toBe("beachbar help\n");
});

test("board without beachbar says how to install it", async () => {
  const missing = await cli(["board", "ls"], { BEACHSIDE_BEACHBAR: join(dir, "no-beachbar") });

  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain("npm install -g @beachside/beachbar");
});

test("create --board mints a token, puts it in the sandbox env, records it and revokes it on rm", async () => {
  const created = await cli([
    "create",
    "--name",
    "worker-1",
    "--prepared",
    "fake-starter",
    "--ttl",
    "2h",
    "--board",
    "fix-auth",
    "--board-role",
    "lead",
    "--json",
  ]);

  expect(created.code, created.stderr).toBe(0);
  expect((await beachbarCalls())[0]).toEqual([
    "--json",
    "token",
    "mint",
    "worker-1",
    "--board",
    "fix-auth",
    "--role",
    "lead",
    "--ttl",
    "7200s",
  ]);

  expect(await sandboxEnv()).toMatchObject({
    BEACHBAR_URL: "https://beachbar.example.workers.dev/v1/b/b_aaaaaaaaaaaaaaaaaaaa",
    BEACHBAR_TOKEN: boardToken,
  });

  const record = JSON.parse(
    await readFile(join(dir, "state", "sandboxes", "worker-1.json"), "utf8"),
  );

  expect(record.board).toEqual({
    board: "fix-auth",
    url: "https://beachbar.example.workers.dev/v1/b/b_aaaaaaaaaaaaaaaaaaaa",
    tokenId: "tok_abcdefghijkl",
    agent: "worker-1",
    role: "lead",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  expect(JSON.stringify(record)).not.toContain(boardToken);

  const inspected = await cli(["inspect", "worker-1"]);

  expect(inspected.stdout).toContain(
    "board     fix-auth as worker-1 (lead), token tok_abcdefghijkl",
  );

  const removed = await cli(["rm", "worker-1"]);

  expect(removed.code, removed.stderr).toBe(0);
  expect((await beachbarCalls()).at(-1)).toEqual([
    "--json",
    "token",
    "revoke",
    "tok_abcdefghijkl",
    "--board",
    "fix-auth",
  ]);
});

test("--board refuses bad options locally and creates nothing when beachbar refuses", async () => {
  for (const [args, message] of [
    [["create", "--board-role", "lead"], "--board-role needs --board"],
    [["create", "--board", "b", "--board-role", "owner"], "not a sandbox role"],
    [["create", "--board", "b", "--network", "blocked"], "--board needs a network"],
    [["create", "--board", "b", "--cache"], "--board cannot be combined with --cache"],
    [["create", "--board", "b", "--env", "BEACHBAR_URL=x"], "--env BEACHBAR_URL would replace"],
  ] as const) {
    const refused = await cli([...args]);

    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain(message);
  }

  const failed = await cli(["create", "--name", "w", "--board", "nope"], {
    FAKE_BEACHBAR_FAIL: "1",
  });

  expect(failed.code).toBe(3);
  expect(failed.stderr).toContain("No board named nope");
  expect(await sandboxEnv()).toEqual({});
  expect((await cli(["ls", "--offline"])).stdout).not.toContain(" w ");
});

test("--board on a provider without sandbox-wide env refuses before minting", async () => {
  await writeFile(
    join(dir, "beachside.json"),
    JSON.stringify({
      default: "noenv",
      profiles: { noenv: { module: fixture, export: "withoutCreateEnv" } },
    }),
  );

  const refused = await cli(["create", "--name", "agent", "--board", "fix-auth"]);

  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain("--board needs sandbox-wide env");
  expect(await beachbarCalls()).toEqual([]);
});
