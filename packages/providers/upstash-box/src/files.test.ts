import {
  AdapterError,
  createAttemptContext,
  type ExecValue,
  type FileTransferContext,
} from "@beachside/adapter";
import { expect, test } from "bun:test";
import {
  appendFile,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { boxFiles, MAX_FILE_BYTES } from "./files";
import {
  APPEND_STAGE,
  COPY_STAGE,
  LINK_STAGE,
  MAKE_STAGE,
  REMOVE_EMPTY_DIRECTORY,
  REMOVE_STAGE,
  type GuestRunner,
} from "./files-shell";
import { createTransport } from "./transport";

const Body = z.object({
  path: z.string().optional(),
  content: z.string().optional(),
  encoding: z.literal("base64").optional(),
  parents: z.boolean().optional(),
  recursive: z.boolean().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const SystemError = z.object({ code: z.string() });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "upstash-files-"));
  const sandbox = { id: "box_test" };
  const signal = new AbortController().signal;

  const attempt = createAttemptContext({
    operationId: "files",
    submissionId: "files",
    invocationKey: "files",
    signal,
  });

  const calls: string[] = [];
  const guestCalls: string[] = [];
  let committedParts = 0;
  let loseRename = false;
  let loseStage = false;
  let denyMkdir = false;
  let denyStat = false;
  let failedRmdir: "denied" | "disappeared" | undefined;

  function local(path: string) {
    if (!path.startsWith(dir + "/") && path !== dir) throw new Error("Path escaped the fixture");

    return path;
  }

  const fetch = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(url, options);
      const endpoint = new URL(request.url);
      const match = /^\/v2\/box\/box_test\/files\/(\w+)$/.exec(endpoint.pathname);

      if (!match) throw new Error("Unexpected filesystem endpoint");
      const operation = match[1];
      calls.push(operation!);

      try {
        if (request.method === "GET") {
          const path = local(
            endpoint.searchParams.get("path") ?? endpoint.searchParams.get("folder") ?? "",
          );

          switch (operation) {
            case "list":
              return Response.json({ files: (await readdir(path)).map((name) => ({ name })) });
            case "stat": {
              if (denyStat) {
                denyStat = false;

                return new Response(null, { status: 403 });
              }

              const entry = await (endpoint.searchParams.get("follow") ? stat(path) : lstat(path));

              const type = entry.isFile()
                ? "file"
                : entry.isDirectory()
                  ? "directory"
                  : entry.isSymbolicLink()
                    ? "symlink"
                    : "other";

              return Response.json({
                type,
                size: entry.size,
                mod_time: entry.mtime.toISOString(),
                version: `${entry.ino}-${entry.mtimeMs}-${entry.size}`,
              });
            }

            case "read": {
              const start = Number(endpoint.searchParams.get("offset"));
              const size = Number(endpoint.searchParams.get("length"));
              const bytes = await readFile(path);

              return Response.json({
                content: bytes.subarray(start, start + size).toString("base64"),
              });
            }

            default:
              throw new Error("Unexpected native filesystem read");
          }
        }

        expect(request.method).toBe("POST");
        const body = Body.parse(await request.json());

        switch (operation) {
          case "write":
            expect(body.encoding).toBe("base64");
            await writeFile(local(body.path!), Buffer.from(body.content!, "base64"));
            break;
          case "mkdir":
            if (denyMkdir) return new Response(null, { status: 403 });
            await mkdir(local(body.path!), { recursive: body.parents });
            break;
          case "remove":
            await rm(local(body.path!), { recursive: body.recursive });
            break;
          case "rename":
            await rename(local(body.from!), local(body.to!));

            if (loseRename) throw new Error("fixture lost the rename acknowledgment");
            break;
          default:
            throw new Error("Unexpected native filesystem mutation");
        }
      } catch (error) {
        const system = SystemError.safeParse(error);

        if (!system.success) throw error;

        if (system.data.code === "ENOENT") return new Response(null, { status: 404 });

        if (system.data.code === "EEXIST") return new Response(null, { status: 400 });
        throw error;
      }

      return new Response(null, { status: 204 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  const run: GuestRunner = async ({ command }) => {
    if (command.kind !== "argv") throw new Error("Filesystem helper requires exact argv");
    const [shell, flag, script, name, first, second] = command.argv;
    guestCalls.push(script!);
    expect([shell, flag, name]).toEqual(["/bin/sh", "-c", "beachside"]);
    const path = local(first!);
    let exitCode = 0;

    // CI Linux exercises the hard-link command itself; the portability fixture uses the same
    // native link syscall on macOS, whose BSD ln does not implement the Linux -T option.
    try {
      switch (script) {
        case MAKE_STAGE:
          await mkdir(path, { mode: 0o700 });

          if (loseStage) throw new Error("fixture lost the mkdir acknowledgment");
          break;
        case REMOVE_STAGE:
          await rm(path, { force: true, recursive: true });
          break;
        case LINK_STAGE:
          if (process.platform === "linux") {
            const child = Bun.spawn(command.argv, { stdout: "ignore", stderr: "ignore" });
            exitCode = await child.exited;
          } else await link(join(path, "data"), local(second!));
          break;
        case APPEND_STAGE:
          await appendFile(join(path, "data"), await readFile(join(path, "chunk")));
          committedParts++;
          break;
        case COPY_STAGE:
          await copyFile(path, join(local(second!), "data"));
          break;
        case REMOVE_EMPTY_DIRECTORY:
          if (failedRmdir) {
            if (failedRmdir === "disappeared") await rmdir(path);
            else denyStat = true;
            exitCode = 1;
          } else await rmdir(path);
          break;
        default:
          throw new Error("Unexpected guest filesystem helper");
      }
    } catch (error) {
      const system = SystemError.safeParse(error);

      if (!system.success) throw error;

      if (system.data.code === "EEXIST" || system.data.code === "ENOTEMPTY") exitCode = 73;
      else throw error;
    }

    const result: ExecValue = {
      exitCode,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      truncated: false,
    };

    return result;
  };

  const files = boxFiles(
    createTransport("https://fixture.invalid", "fixture", fetch),
    run,
    (box) => {
      if (box.id !== sandbox.id) throw new AdapterError("CONFLICT", "Wrong sandbox");

      return box.id;
    },
  );

  return {
    dir,
    files,
    sandbox,
    attempt,
    calls,
    guestCalls,
    committedParts: () => committedParts,
    loseRename: () => {
      loseRename = true;
    },
    loseStage: () => {
      loseStage = true;
    },
    denyMkdir: () => {
      denyMkdir = true;
    },
    failRmdir: (mode: NonNullable<typeof failedRmdir>) => {
      failedRmdir = mode;
    },
    read: { signal, deadline: Date.now() + 30000 },
    path: (name: string) => ({ sandbox, path: join(dir, name) }),
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
}

async function* input(...parts: Uint8Array[]) {
  yield* parts;
}

test("native filesystem primitives preserve dangling links and path errors", async () => {
  await using f = await fixture();
  const dir = f.path("folder");
  const dangling = f.path("folder/link");
  const file = f.path("folder/data");

  expect(await f.files.makeDirectory({ ...dir, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
  expect(await f.files.makeDirectory({ ...dir, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
  await writeFile(file.path, Uint8Array.of(0, 255));
  await symlink("missing", dangling.path);

  expect(await f.files.readDirectory(dir, f.read)).toMatchObject({
    completeness: "complete",
    entries: [
      { name: "data", type: "file" },
      { name: "link", type: "symlink" },
    ],
  });
  expect(await f.files.stat({ ...file, followSymlinks: false }, f.read)).toMatchObject({
    type: "file",
    sizeBytes: 2,
  });
  expect(await f.files.stat({ ...dangling, followSymlinks: false }, f.read)).toMatchObject({
    type: "symlink",
  });
  expect(await f.files.exists(dangling, f.read)).toBe(true);
  await expect(f.files.stat({ ...dangling, followSymlinks: true }, f.read)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(f.files.read(f.path("absent"), f.read)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(f.files.read(dir, f.read)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

  expect(await f.files.remove({ ...dir, recursive: false }, f.attempt)).toMatchObject({
    code: "CONFLICT",
  });
  expect(await f.files.remove({ ...dangling, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
  expect(await f.files.exists(dangling, f.read)).toBe(false);
  expect(await f.files.remove({ ...file, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
  expect(await f.files.remove({ ...dir, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
  expect(await f.files.remove({ ...dir, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
});

test("stream writes are backpressured and publication does not clobber rivals or symlinks", async () => {
  await using f = await fixture();
  const target = f.path("destination with a 'quote'");
  const full = new Uint8Array(MAX_FILE_BYTES).fill(0x80);
  const tail = Uint8Array.of(0, 255, 1);

  async function* bytes() {
    yield full;
    expect(f.committedParts()).toBe(1);
    expect(await f.files.exists(target, f.read)).toBe(false);
    yield tail;
  }

  expect(
    await f.files.writeStream({ ...target, bytes: bytes(), overwrite: false }, f.read),
  ).toEqual({ bytesWritten: full.length + tail.length });
  expect((await readFile(target.path)).equals(Buffer.concat([full, tail]))).toBe(true);

  const race = f.path("race");

  const results = await Promise.allSettled(
    [0x80, 0xff].map((last) =>
      f.files.writeStream(
        { ...race, overwrite: false, bytes: input(Uint8Array.of(0, last)) },
        f.read,
      ),
    ),
  );

  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  const conflict = results.find(({ status }) => status === "rejected");

  if (conflict?.status !== "rejected") throw new Error("Missing the losing writer");
  expect(conflict.reason).toMatchObject({ code: "CONFLICT" });
  expect([0x80, 0xff]).toContain((await readFile(race.path))[1]);

  const linkPath = f.path("link");
  await symlink(race.path, linkPath.path);
  const original = await readFile(race.path);
  await expect(
    f.files.writeStream({ ...linkPath, overwrite: false, bytes: input(tail) }, f.read),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readlink(linkPath.path)).toBe(race.path);
  expect(await readFile(race.path)).toEqual(original);
  expect((await readdir(f.dir)).filter((name) => name.startsWith(".beachside-"))).toEqual([]);
});

test("copy preserves existing files and lost overwrite acknowledgment is not replayed", async () => {
  await using f = await fixture();
  const source = f.path("source");
  const destination = f.path("destination");
  const bytes = Uint8Array.of(0, 255);

  await writeFile(source.path, bytes);
  const transfer = { sandbox: f.sandbox, source: source.path, destination: destination.path };

  expect(await f.files.copy({ ...transfer, overwrite: false }, f.read)).toEqual({
    acknowledged: true,
  });
  await expect(f.files.copy({ ...transfer, overwrite: false }, f.read)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(await readFile(destination.path)).toEqual(Buffer.from(bytes));

  await expect(f.files.move({ ...transfer, overwrite: false }, f.read)).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(await readFile(source.path)).toEqual(Buffer.from(bytes));

  const retained: Parameters<NonNullable<FileTransferContext["retain"]>>[0] = {};
  f.loseRename();
  await expect(
    f.files.writeStream(
      { ...destination, overwrite: true, bytes: input(Uint8Array.of(0x80)) },
      {
        ...f.read,
        retain(details) {
          Object.assign(retained, details);
        },
      },
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", details: { effect: "unknown" } });
  expect(f.calls.filter((call) => call === "rename")).toHaveLength(1);
  expect(retained.temporaryPaths).toHaveLength(1);
});

test("staging checks the followed parent and retains an unverified candidate without cleaning it", async () => {
  await using f = await fixture();
  const bytes = Uint8Array.of(0, 255);
  const missing = f.path("missing/file");
  await expect(
    f.files.writeStream({ ...missing, bytes: input(bytes), overwrite: false }, f.read),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await f.files.write({ ...missing, bytes, overwrite: false }, f.attempt)).toMatchObject({
    code: "NOT_FOUND",
  });
  expect(f.guestCalls).toEqual([]);

  const actual = f.path("actual");
  const alias = f.path("alias");
  await mkdir(actual.path);
  await symlink(actual.path, alias.path);
  const destination = f.path("alias/destination");
  const retained: Parameters<NonNullable<FileTransferContext["retain"]>>[0] = {};
  f.loseStage();

  await expect(
    f.files.writeStream(
      { ...destination, bytes: input(bytes), overwrite: false },
      {
        ...f.read,
        retain(details) {
          Object.assign(retained, details);
        },
      },
    ),
  ).rejects.toMatchObject({
    code: "UNAVAILABLE",
    details: { effect: "none", temporaryPaths: [expect.stringContaining("/alias/.beachside-")] },
  });
  const candidate = retained.temporaryPaths?.[0];

  if (!candidate) throw new Error("Missing unverified staging candidate");
  expect((await lstat(candidate)).isDirectory()).toBe(true);
  expect(await f.files.exists(destination, f.read)).toBe(false);
  expect(f.guestCalls).toEqual([MAKE_STAGE]);
});

test("buffered writes report only the safe stage name after a lost reservation", async () => {
  await using f = await fixture();
  const destination = f.path("private parent/sensitive destination");
  await mkdir(f.path("private parent").path);
  f.loseStage();

  const result = await f.files.write(
    { ...destination, bytes: Uint8Array.of(0, 255), overwrite: false },
    f.attempt,
  );

  if (!("reason" in result)) throw new Error("Missing the unknown file write outcome");
  const [stage] = result.reason.match(/\.beachside-[0-9a-f-]{36}/) ?? [];

  if (!stage) throw new Error("Missing the staging candidate name");
  expect(result.reason).not.toContain(destination.path);
  expect(result.reason).not.toContain("private parent");
  expect(result.reason).not.toContain("sensitive destination");
  expect((await lstat(f.path(`private parent/${stage}`).path)).isDirectory()).toBe(true);
  expect(f.guestCalls).toEqual([MAKE_STAGE]);
});

test("directory mutation does not turn denied writes or observations into success", async () => {
  await using f = await fixture();
  const folder = f.path("directory");
  await mkdir(folder.path);
  f.denyMkdir();

  expect(await f.files.makeDirectory({ ...folder, recursive: false }, f.attempt)).toMatchObject({
    code: "FORBIDDEN",
  });
  expect(f.calls).toEqual(["mkdir"]);

  f.failRmdir("denied");
  expect(await f.files.remove({ ...folder, recursive: false }, f.attempt)).toMatchObject({
    code: "FORBIDDEN",
  });
  expect((await lstat(folder.path)).isDirectory()).toBe(true);

  f.failRmdir("disappeared");
  expect(await f.files.remove({ ...folder, recursive: false }, f.attempt)).toEqual({
    acknowledged: true,
  });
  expect(await f.files.exists(folder, f.read)).toBe(false);
});
