import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { beachbarArguments } from "../src/board";
import { boardToken, startFakeBoard, tokenId } from "./fake-board";

const token = "local-test-token-12345";
const main = join(import.meta.dir, "..", "src", "main.ts");
const fixture = join(import.meta.dir, "fake-adapter.ts");

let root: string;
let dir: string;
let provider: Awaited<ReturnType<typeof startFakeProviderServer>>;
let board: Awaited<ReturnType<typeof startFakeBoard>>;

const boardIds = {
  "fix-auth": "b_aaaaaaaaaaaaaaaaaaaa",
  one: "b_one",
  two: "b_two",
  b: "b_bbb",
} satisfies Record<string, string>;

/** Writes the owner's beachbar config with the saved boards, optionally moving one elsewhere. */
async function saveBoards(ids: Readonly<Record<string, string>> = boardIds): Promise<void> {
  const boards = Object.fromEntries(
    Object.entries(ids).map(([name, id]) => [
      name,
      { server: "default", id, url: board.url(id), token: "bbr_owner_token", agent: "owner" },
    ]),
  );

  await writeFile(
    join(dir, "beachbar.json"),
    JSON.stringify({ servers: {}, boards, currentBoard: null }),
  );
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "beachside-board-")));
  provider = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(root, "fake.json"),
    token,
    testMode: true,
  });
  board = await startFakeBoard();
});

afterAll(async () => {
  await provider.stop(true);
  await board.stop();
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fetch(new URL("/_test/reset", provider.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  board.reset();
  dir = await mkdtemp(join(root, "case-"));
  await saveBoards();
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
      BEACHBAR_CONFIG: join(dir, "beachbar.json"),
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

/** The board calls made so far, as `METHOD /path`. */
function boardCalls(): string[] {
  return board.calls.map((call) => `${call.method} ${call.path}`);
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

test("board runs beachbar's own commands in process", async () => {
  const listed = await cli(["board", "token", "ls", "--board", "fix-auth", "--json"]);

  expect(listed.code, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({ ok: true, data: [] });
  expect(boardCalls()).toEqual(["GET /tokens"]);

  const help = await cli(["board"]);

  expect(help.code).toBe(0);
  expect(help.stdout).toContain("beachbar task take");
  expect((await cli(["board", "nonsense-command"])).code).toBe(2);

  const used = await cli(["board", "use", "fix-auth"]);

  expect(used.code, used.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(dir, "beachbar.json"), "utf8")).currentBoard).toBe(
    "fix-auth",
  );
});

test("board words go under `board`, even after beachbar's global flags", () => {
  expect(beachbarArguments(["create", "fix-auth"], false)).toEqual(["board", "create", "fix-auth"]);
  expect(beachbarArguments(["--server", "prod", "create", "fix-auth"], false)).toEqual([
    "--server",
    "prod",
    "board",
    "create",
    "fix-auth",
  ]);
  expect(beachbarArguments(["task", "add", "x", "--board", "fix-auth"], true)).toEqual([
    "--json",
    "task",
    "add",
    "x",
    "--board",
    "fix-auth",
  ]);
  expect(beachbarArguments(["--board", "create", "status"], false)).toEqual([
    "--board",
    "create",
    "status",
  ]);
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
  expect(board.calls[0]).toEqual({
    method: "POST",
    path: "/tokens",
    body: { agent: "worker-1", role: "lead", ttlSeconds: 7200 },
  });

  expect(await sandboxEnv()).toMatchObject({
    BEACHBAR_URL: board.url("b_aaaaaaaaaaaaaaaaaaaa"),
    BEACHBAR_TOKEN: boardToken,
  });

  const record = JSON.parse(
    await readFile(join(dir, "state", "sandboxes", "worker-1.json"), "utf8"),
  );

  expect(record.board).toEqual({
    board: "fix-auth",
    url: board.url("b_aaaaaaaaaaaaaaaaaaaa"),
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
  expect(boardCalls().at(-1)).toBe(`DELETE /tokens/${tokenId}`);
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

  const failed = await cli(["create", "--name", "w", "--board", "nope"]);

  expect(failed.code).toBe(3);
  expect(failed.stderr).toContain("No saved board named nope");
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
  expect(board.calls).toEqual([]);
});

test("run --board mints a token and revokes it when the sandbox goes", async () => {
  const seeded = await fetch(new URL("/_test/seed", provider.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      submissionId: "*",
      action: "exec",
      command: {
        command: { kind: "argv", argv: ["echo", "hi"] },
        // The fake matches the whole env, which --board fills.
        env: {
          BEACHBAR_URL: board.url("b_aaaaaaaaaaaaaaaaaaaa"),
          BEACHBAR_TOKEN: boardToken,
        },
        exitCode: 0,
        stdoutBase64: Buffer.from("hi\n").toString("base64"),
        stderrBase64: "",
      },
    }),
  });

  expect(seeded.status, await seeded.text()).toBe(200);

  const ran = await cli([
    "run",
    "--prepared",
    "fake-starter",
    "--board",
    "fix-auth",
    "--",
    "echo",
    "hi",
  ]);

  expect(ran.code, ran.stderr).toBe(0);

  expect(boardCalls()[0]).toBe("POST /tokens");
  expect(boardCalls().at(-1)).toBe(`DELETE /tokens/${tokenId}`);
});

test("gc revokes the board token of each sandbox it destroys", async () => {
  const made = await cli([
    "create",
    "--name",
    "job-1",
    "--prepared",
    "fake-starter",
    "--label",
    "run=7",
    "--board",
    "fix-auth",
  ]);

  expect(made.code, made.stderr).toBe(0);

  const collected = await cli(["gc", "--label", "run=7"]);

  expect(collected.code, collected.stderr).toBe(0);
  expect(boardCalls().at(-1)).toBe(`DELETE /tokens/${tokenId}`);
});

test("rm says when a board token could not be revoked, and a token already gone is fine", async () => {
  const make = (name: string) =>
    cli(["create", "--name", name, "--prepared", "fake-starter", "--board", "fix-auth"]);

  expect((await make("a")).code).toBe(0);

  await saveBoards({});

  const unsaved = await cli(["rm", "a"]);

  expect(unsaved.code, unsaved.stderr).toBe(0);
  expect(unsaved.stderr).toContain("could not revoke board token tok_abcdefghijkl");
  expect(unsaved.stderr).toContain(
    "beachside board token revoke tok_abcdefghijkl --board fix-auth",
  );

  await saveBoards();
  expect((await make("b")).code).toBe(0);

  // The board was re-created under the same name: the saved one is another board now.
  await saveBoards({ ...boardIds, "fix-auth": "b_recreated" });

  const recreated = await cli(["rm", "b"]);

  expect(recreated.stderr).toContain("is not the board at");
  expect(boardCalls().at(-1)).toBe("POST /tokens");

  await saveBoards();
  expect((await make("c")).code).toBe(0);
  board.set({ revokeGone: true });

  const gone = await cli(["rm", "c"]);

  expect(gone.code).toBe(0);
  expect(gone.stderr).not.toContain("could not revoke");
});

test("--board limits are usage errors, and beachbar's codes keep their meaning", async () => {
  for (const [args, message] of [
    [["create", "--board", "b", "--board-ttl", "30s"], "between 60s and 366d"],
    [["create", "--board", "b", "--board-ttl", "400d"], "between 60s and 366d"],
    [["create", "--board", "b", "--ttl", "30s"], "between 60s and 366d"],
    [["create", "--board", "Bad_Name"], "--board takes a board name"],
    [["create", "--name", `w${"x".repeat(50)}`, "--board", "b"], "--board-agent"],
  ] as const) {
    const refused = await cli([...args]);

    expect(refused.code, refused.stderr).toBe(2);
    expect(refused.stderr).toContain(message);
  }

  board.set({ rateLimited: true });

  const limited = await cli(["create", "--name", "w", "--board", "b", "--json"]);

  expect(limited.code).toBe(7);
  expect(JSON.parse(limited.stdout).error).toMatchObject({ code: "RATE_LIMIT", retryable: true });
});

test("a garbled mint answer says the token may be live, and never prints it", async () => {
  board.set({ garbled: true });

  const garbled = await cli(["create", "--name", "w", "--board", "fix-auth"]);

  expect(garbled.code).not.toBe(0);
  expect(garbled.stderr).toContain("the token may be live");
  expect(await sandboxEnv()).toEqual({});
});

test("--if-not-exists --board refuses a sandbox made for another board", async () => {
  expect(
    (await cli(["create", "--name", "w", "--prepared", "fake-starter", "--board", "one"])).code,
  ).toBe(0);

  const other = await cli([
    "create",
    "--name",
    "w",
    "--prepared",
    "fake-starter",
    "--if-not-exists",
    "--board",
    "two",
  ]);

  expect(other.code).toBe(1);
  expect(other.stderr).toContain("token for board one, not two");
});
