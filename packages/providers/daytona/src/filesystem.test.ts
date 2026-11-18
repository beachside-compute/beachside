import { z } from "zod";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FILESYSTEM_HELPER,
  filesystemResult,
  type FilesystemInput,
  type FilesystemValue,
} from "./filesystem";
import { daytonaProvider, createDaytonaAdapter } from "./index";
import { Beachside, AdapterSandbox } from "beachside";
import { artifactFiles } from "../../../../apps/docs/examples/directory-files";

/**
 * Tests that run the guest helper's no-clobber copies and moves on the host, which need
 * Linux `renameat2` as every Daytona guest has. They run on Linux, as in CI, and are
 * skipped elsewhere, such as macOS.
 */
const linuxGuest = test.skipIf(process.platform !== "linux");

function run(input: FilesystemInput) {
  const result = spawnSync(
    "python3",
    ["-c", FILESYSTEM_HELPER, Buffer.from(JSON.stringify(input)).toString("base64")],
    { encoding: "utf8" },
  );

  expect(result.status).toBe(0);

  return filesystemResult(result.stdout);
}

test("recursive mkdir reports possible effects when a parent is created before the leaf fails", () => {
  const root = mkdtempSync(join(tmpdir(), "beachside-daytona-mkdir-"));
  const parent = join(root, "created-parent");

  try {
    expect(() =>
      run({ op: "mkdir", path: join(parent, "x".repeat(300)), recursive: true }),
    ).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ effect: "possible" }) }),
    );
    expect(existsSync(parent)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

linuxGuest(
  "guest filesystem preserves unusual names, dangling links, directory protection and staged copy",
  () => {
    const root = mkdtempSync(join(tmpdir(), "beachside-daytona-fs-"));
    const source = join(root, "quote'\n雪.bin");

    try {
      writeFileSync(source, new Uint8Array([0, 255, 1]));
      symlinkSync(join(root, "absent"), join(root, "dangling"));
      mkdirSync(join(root, "empty"));
      expect(spawnSync("mkfifo", [join(root, "pipe")]).status).toBe(0);
      expect(run({ op: "list", path: root })).toEqual([
        { name: "dangling", type: "symlink" },
        { name: "empty", type: "directory" },
        { name: "pipe", type: "unknown" },
        { name: "quote'\n雪.bin", type: "file" },
      ]);
      expect(run({ op: "exists", path: join(root, "dangling") })).toBe(true);
      expect(() => run({ op: "mkdir", path: source, recursive: true })).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      expect(() => run({ op: "mkdir", path: source, recursive: false })).toThrow(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      symlinkSync(join(root, "empty"), join(root, "directory-link"));
      expect(run({ op: "mkdir", path: join(root, "directory-link"), recursive: false })).toBe(true);
      writeFileSync(join(root, "empty", "child"), "intermediate-link");
      expect(run({ op: "list", path: join(root, "directory-link") })).toEqual([
        { name: "child", type: "file" },
      ]);
      expect(
        run({ op: "remove", path: join(root, "directory-link", "child"), recursive: false }),
      ).toBe(true);
      expect(existsSync(join(root, "empty", "child"))).toBe(false);
      expect(run({ op: "remove", path: join(root, "directory-link"), recursive: true })).toBe(true);
      expect(existsSync(join(root, "empty"))).toBe(true);

      expect(run({ op: "stat", path: join(root, "dangling") })).toMatchObject({ type: "symlink" });
      expect(() => run({ op: "stat", path: join(root, "dangling"), follow: true })).toThrow();
      expect(() => run({ op: "remove", path: root, recursive: false })).toThrow();
      const reserved = join(root, ".stream-stage");
      expect(run({ op: "reserve", path: reserved })).toBe(reserved);
      expect(existsSync(reserved)).toBe(true);
      expect(() => run({ op: "reserve", path: reserved })).toThrow();
      expect(run({ op: "cleanup", path: reserved })).toBe(true);
      expect(existsSync(reserved)).toBe(false);

      const copy = join(root, "copied");
      expect(
        run({
          op: "copy",
          source,
          destination: copy,
          stagingDirectory: join(root, ".copy-stage"),
          overwrite: true,
        }),
      ).toBe(true);
      expect(readFileSync(copy)).toEqual(readFileSync(source));

      try {
        run({
          op: "copy",
          source,
          destination: copy,
          stagingDirectory: join(root, ".collision-stage"),
          overwrite: false,
        });
        throw new Error("No-clobber unexpectedly replaced destination");
      } catch (error) {
        expect(error).toMatchObject({
          code: "CONFLICT",
        });
      }

      expect(existsSync(join(root, ".collision-stage"))).toBe(false);
      expect(new Uint8Array(readFileSync(source))).toEqual(new Uint8Array([0, 255, 1]));
      expect(readFileSync(copy)).toEqual(readFileSync(source));
      const directorySource = join(root, "directory-source");
      const directoryDestination = join(root, "directory-destination");
      mkdirSync(directorySource);

      expect(
        run({
          op: "move",
          source: directorySource,
          destination: directoryDestination,
          overwrite: false,
        }),
      ).toBe(true);
      expect(existsSync(directorySource)).toBe(false);
      expect(existsSync(directoryDestination)).toBe(true);

      expect(() =>
        run({
          op: "copy",
          source: join(root, "dangling"),
          destination: copy,
          stagingDirectory: join(root, ".copy-stage"),
          overwrite: true,
        }),
      ).toThrow();
      expect(() => run({ op: "move", source, destination: source, overwrite: true })).toThrow();
      expect(run({ op: "remove", path: join(root, "empty"), recursive: false })).toBe(true);
      expect(run({ op: "remove", path: join(root, "absent"), recursive: false })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Daytona transfer transport streams 32 MiB with incremental multipart input and matching completion", async () => {
  const size = 32 * 1024 * 1024;
  let uploaded = 0;
  let cleanup = 0;
  let stageDirectory = "";

  const impl: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/api-keys/current"))
        return Response.json({ organizationId: "org" });

      if (url.pathname.endsWith("/regions"))
        return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

      if (url.pathname === "/api/sandbox/box")
        return Response.json({
          id: "box",
          name: "box",
          organizationId: "org",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        });

      if (url.pathname.endsWith("/process/execute")) {
        const command = z
          .object({ command: z.string() })
          .parse(JSON.parse(String(init?.body))).command;

        const argument = command.slice(command.lastIndexOf(" '") + 2, -1);

        const args = z
          .object({ op: z.string(), path: z.string().optional() })
          .parse(JSON.parse(Buffer.from(argument, "base64").toString()));

        if (args.op === "cleanup") cleanup++;

        if (args.op === "reserve") stageDirectory = args.path!;

        return Response.json({
          exitCode: 0,
          result: JSON.stringify({
            ok: true,
            value:
              args.op === "reserve"
                ? stageDirectory
                : args.op === "stat"
                  ? { type: "file", sizeBytes: size, mode: 384, modifiedAt: "2026-10-08T00:00:00Z" }
                  : true,
          }),
        });
      }

      if (url.pathname.endsWith("/files/upload-v2")) {
        expect(init?.body).toBeInstanceOf(ReadableStream);

        if (!(init?.body instanceof ReadableStream))
          throw new Error("Expected streaming multipart");

        const reader = init.body.getReader();
        let index = 0;

        for (;;) {
          const next = await reader.read();

          if (next.done) break;

          if (index++ && next.value.byteLength === 65536) {
            expect(next.value[0]).toBe(239);
            expect(next.value[65535]).toBe(239);
            uploaded += next.value.byteLength;
          }
        }

        return Response.json({ path: `${stageDirectory}/payload`, name: "payload", type: "file" });
      }

      if (url.pathname.endsWith("/files/download")) {
        let count = 0;

        return new Response(
          new ReadableStream({
            pull(controller) {
              if (count === size) controller.close();
              else {
                controller.enqueue(new Uint8Array(65536).fill(239));
                count += 65536;
              }
            },
          }),
          { headers: { "content-length": String(size) } },
        );
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const { driver, scope } = await daytonaProvider({
    apiKey: "fixture",
    target: "us",
    networkPolicy: "blocked",
    fetch: impl,
  });

  const sandbox = { kind: "sandbox" as const, nativeId: "box", scope };

  const written = await driver.writeFileStream({
    sandbox,
    path: "/workspace/archive",
    overwrite: false,
    bytes: (async function* () {
      for (let i = 0; i < size / 65536; i++) yield new Uint8Array(65536).fill(239);
    })(),
  });

  expect(written.bytesWritten).toBe(size);
  expect(uploaded).toBe(size);
  expect(cleanup).toBe(1);
  const reader = (await driver.readFileStream({ sandbox, path: "/workspace/archive" })).getReader();
  let downloaded = 0;

  for (;;) {
    const next = await reader.read();

    if (next.done) break;
    downloaded += next.value.byteLength;
    expect(next.value.every((b) => b === 239)).toBe(true);
  }

  expect(downloaded).toBe(size);
});

linuxGuest(
  "Daytona public SDK preserves definitive filesystem rejections and artifact workflow outcomes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "beachside-daytona-public-files-"));
    let client: Awaited<ReturnType<typeof Beachside.connect>> | undefined;
    let delayCleanup = false;
    let delayedStage = "";
    let releaseCleanup: (() => void) | undefined;

    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });

    let cleanupFinished: Promise<void> | undefined;

    try {
      const transport: typeof fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(String(input));

          if (url.pathname.endsWith("/api-keys/current"))
            return Response.json({ organizationId: "org" });

          if (url.pathname.endsWith("/regions"))
            return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

          if (url.pathname.endsWith("/organizations/org"))
            return Response.json({ id: "org", sandboxLimitedNetworkEgress: false });

          if (url.pathname === "/api/sandbox/box")
            return Response.json({
              id: "box",
              name: "box",
              organizationId: "org",
              target: "us",
              state: "started",
              networkBlockAll: true,
              public: false,
              toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
            });

          if (url.pathname.endsWith("/process/execute")) {
            const request = z.object({ command: z.string() }).parse(JSON.parse(String(init?.body)));

            if (delayCleanup) {
              const argument = request.command.slice(request.command.lastIndexOf(" '") + 2, -1);

              const operation = z
                .object({ op: z.string(), path: z.string().optional() })
                .parse(JSON.parse(Buffer.from(argument, "base64").toString()));

              if (operation.op === "cleanup") {
                delayedStage = operation.path!;
                cleanupFinished = cleanupReleased.then(() => {
                  const execution = spawnSync("sh", ["-c", request.command], { encoding: "utf8" });
                  expect(execution.status).toBe(0);
                });
                await cleanupFinished;

                return Response.json({
                  result: JSON.stringify({ ok: true, value: true }),
                  exitCode: 0,
                });
              }
            }

            const execution = spawnSync("sh", ["-c", request.command], { encoding: "utf8" });

            return Response.json({ result: execution.stdout, exitCode: execution.status });
          }

          if (url.pathname.endsWith("/files/upload-v2")) {
            const form =
              init?.body instanceof FormData
                ? init.body
                : await new Response(init?.body, {
                    headers: { "content-type": new Headers(init?.headers).get("content-type")! },
                  }).formData();

            const file = form.get("file");

            if (!(file instanceof Blob)) throw new Error("Expected multipart upload file");
            const path = url.searchParams.get("path")!;
            writeFileSync(path, new Uint8Array(await file.arrayBuffer()));

            return Response.json({ path, name: "payload", type: "file" });
          }

          if (url.pathname.endsWith("/files/download"))
            return new Response(readFileSync(url.searchParams.get("path")!));
          throw new Error(`Unexpected public filesystem fixture route ${url.pathname}`);
        },
        { preconnect: fetch.preconnect },
      );

      client = await Beachside.connect({
        adapter: createDaytonaAdapter(transport),
        config: { target: "us", networkPolicy: "blocked" },
        credentials: { apiKey: "fixture" },
      });

      const box = new AdapterSandbox(client, "box");
      await box.makeDirectory(join(root, "results"), { recursive: true });
      const source = join(root, "results", "source.bin");
      const payload = new Uint8Array(2 * 1024 * 1024).fill(239);
      await box.writeFile(source, payload, { overwrite: true, maxBytes: payload.byteLength });
      await expect(box.makeDirectory(source)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(box.makeDirectory(source, { recursive: true })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(box.removeFile(join(root, "results"))).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(await box.readDirectory(join(root, "results"))).toMatchObject({
        completeness: "complete",
        entries: [{ name: "source.bin", type: "file" }],
      });
      expect(await box.statFile(source)).toMatchObject({
        type: "file",
        sizeBytes: payload.byteLength,
      });
      const copy = join(root, "copy.bin");
      const final = join(root, "final.bin");
      await box.copyFile(source, copy, { overwrite: true });
      await box.moveFile(copy, final, { overwrite: true });
      expect(await box.fileExists(copy)).toBe(false);
      expect(await box.readFile(final, { maxBytes: payload.byteLength })).toEqual(payload);

      const chunks: Uint8Array[] = [];
      const artifactRoot = join(root, "artifacts");

      const artifact = await artifactFiles(
        box,
        (async function* () {
          yield payload.subarray(0, 65536);
          yield payload.subarray(65536, 131072);
        })(),
        {
          async write(chunk) {
            chunks.push(chunk);
          },
        },
        artifactRoot,
      );

      expect(Buffer.concat(chunks)).toEqual(Buffer.from(payload.subarray(0, 131072)));
      expect(artifact.uploaded).toBe(131072);
      expect(artifact.directory.completeness).toBe("complete");
      expect(artifact.lines).toEqual(["ready ✓", "complete"]);
      expect(artifact.entries.map((entry) => entry.relativePath)).toEqual([
        "archive.bin",
        "final.json",
        "results",
        "results/events.txt",
        "results/report.json",
      ]);
      expect(existsSync(artifactRoot)).toBe(false);

      delayCleanup = true;
      const published = join(root, "confirmed-before-cleanup.bin");

      const write = box.writeFileStream(
        published,
        (async function* () {
          yield payload;
        })(),
        { overwrite: true, overallTimeoutMs: 2000 },
      );

      try {
        await expect(write).rejects.toMatchObject({
          code: "TIMEOUT",
          effect: "applied",
          details: {
            effect: "applied",
            destination: published,
            bytesTransferred: payload.byteLength,
            temporaryPaths: [expect.stringContaining(".beachside-stream-")],
          },
        });
        expect(readFileSync(published)).toEqual(Buffer.from(payload));
        expect(existsSync(delayedStage)).toBe(true);
      } finally {
        releaseCleanup?.();
      }

      await cleanupFinished;
      expect(existsSync(delayedStage)).toBe(false);
      await box.removeFile(root, { recursive: true });
      expect(existsSync(root)).toBe(false);
    } finally {
      releaseCleanup?.();

      try {
        await cleanupFinished;
      } finally {
        try {
          await client?.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
  30_000,
);

test("Daytona interrupted and malformed helpers retain possible copy effects and staging custody", async () => {
  const root = mkdtempSync(join(tmpdir(), "beachside-daytona-interrupted-"));
  const source = join(root, "source");
  const destination = join(root, "destination");
  const stagingDirectory = join(root, ".stage");
  let failure = "exit";

  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/api-keys/current"))
        return Response.json({ organizationId: "org" });

      if (url.pathname.endsWith("/regions"))
        return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

      if (url.pathname === "/api/sandbox/box")
        return Response.json({
          id: "box",
          name: "box",
          organizationId: "org",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        });

      if (url.pathname.endsWith("/process/execute")) {
        if (failure === "prerequisite")
          return Response.json({
            exitCode: 0,
            result: JSON.stringify({
              ok: false,
              errno: 38,
              errorName: "ENOSYS",
              applied: false,
              possible: false,
              temporaryPaths: [],
            }),
          });

        mkdirSync(stagingDirectory);
        writeFileSync(join(stagingDirectory, "payload"), "partial copy");
        writeFileSync(destination, "published before interruption");

        if (failure === "transport") throw new Error("connection lost after mutation");

        if (failure === "http") return new Response(null, { status: 503 });

        if (failure === "envelope") return Response.json({ exitCode: 0 });

        if (failure === "partial-rejection")
          return Response.json({
            exitCode: 0,
            result: JSON.stringify({ ok: false, errno: 38, errorName: "ENOSYS" }),
          });

        return Response.json({
          exitCode: failure === "exit" ? 137 : 0,
          result: failure === "receipt" ? "{}" : JSON.stringify({ ok: false }),
        });
      }

      throw new Error(`Unexpected interrupted helper fixture route ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  try {
    const { driver, scope } = await daytonaProvider({
      apiKey: "fixture",
      target: "us",
      networkPolicy: "blocked",
      fetch: transport,
    });

    const sandbox = { kind: "sandbox" as const, nativeId: "box", scope };
    const input = { op: "copy", source, destination, stagingDirectory, overwrite: true };

    for (failure of [
      "exit",
      "transport",
      "http",
      "envelope",
      "receipt",
      "incomplete",
      "partial-rejection",
    ]) {
      await expect(driver.filesystem(sandbox, input)).rejects.toMatchObject({
        code: "UNAVAILABLE",
        details: { effect: "possible", source, destination, temporaryPaths: [stagingDirectory] },
      });
      expect(readFileSync(destination, "utf8")).toBe("published before interruption");
      expect(existsSync(join(stagingDirectory, "payload"))).toBe(true);
      rmSync(stagingDirectory, { recursive: true });
    }

    failure = "prerequisite";
    await expect(driver.filesystem(sandbox, input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(existsSync(stagingDirectory)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A deterministic in-memory guest for the Daytona toolbox. It understands only the
 * commands the adapter's write path issues, so an unexpected command fails loudly.
 * It proves Beachside's orchestration (parents, staging, publication, cleanup);
 * the Linux link/renameat2 semantics themselves are covered by the native tests above.
 */
type GuestReply = { result: string; exitCode: number };

const HelperInput = z.object({
  op: z.string(),
  path: z.string().optional(),
  source: z.string().optional(),
  destination: z.string().optional(),
  stagingDirectory: z.string().optional(),
  overwrite: z.boolean().optional(),
});

class RecordingGuest {
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly directories = new Set<string>(["/", "/tmp"]);
  readonly events: string[] = [];

  mkdir(path: string, parents: boolean) {
    const parent = dirname(path);

    if (!this.directories.has(parent)) {
      if (!parents) return false;
      this.mkdir(parent, true);
    }

    if (this.directories.has(path) && !parents) return false;
    this.directories.add(path);

    return true;
  }

  remove(path: string) {
    for (const key of this.files.keys())
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);

    for (const key of this.directories)
      if (key === path || key.startsWith(`${path}/`)) this.directories.delete(key);
  }

  publish(from: string, to: string, overwrite: boolean) {
    const bytes = this.files.get(from);

    if (!bytes || !this.directories.has(dirname(to))) return false;

    if (!overwrite && (this.files.has(to) || this.directories.has(to))) return false;
    this.files.set(to, bytes);
    this.files.delete(from);
    this.events.push(`publish ${to}`);

    return true;
  }

  helper(input: FilesystemInput): FilesystemValue {
    const path = input.path ?? "";

    switch (input.op) {
      case "reserve":
        this.mkdir(dirname(path), true);
        this.mkdir(path, false);
        this.events.push(`stage ${path}`);

        return path;
      case "stat": {
        const bytes = this.files.get(path)!;

        return {
          type: "file",
          sizeBytes: bytes.length,
          mode: 0o644,
          modifiedAt: new Date(0).toISOString(),
        };
      }

      case "publish":
        return this.publish(path, input.destination!, input.overwrite!);
      case "cleanup":
        this.remove(path);
        this.events.push(`cleanup ${path}`);

        return true;
      case "copy": {
        const stage = input.stagingDirectory!;
        this.mkdir(dirname(stage), true);
        this.mkdir(stage, false);
        this.events.push(`stage ${stage}`);
        this.files.set(`${stage}/payload`, this.files.get(input.source!)!);
        const published = this.publish(`${stage}/payload`, input.destination!, input.overwrite!);
        this.remove(stage);

        return published;
      }

      default:
        throw new Error(`Unexpected guest helper op ${input.op}`);
    }
  }

  execute(command: string): GuestReply {
    const quoted = [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) =>
      match[1]!.replaceAll("'\\''", "'"),
    );

    if (command.startsWith("python3 -c ")) {
      const input = HelperInput.parse(JSON.parse(Buffer.from(quoted.at(-1)!, "base64").toString()));

      return { result: JSON.stringify({ ok: true, value: this.helper(input) }), exitCode: 0 };
    }

    if (command.startsWith("mkdir -m 700 -- ")) {
      // A private stage beside the destination and a receipt directory. The stage's
      // parent exists only if the command itself asks for it with mkdir -p.
      const [stage] = quoted;
      const receipt = quoted.find((path) => path.startsWith("/tmp/.beachside-write-"));
      const parent = dirname(stage!);

      if (command.includes(`mkdir -p -- '${parent}'`)) {
        this.mkdir(parent, true);
        this.events.push(`parent ${parent}`);
      }

      if (!this.mkdir(stage!, false) || !receipt || !this.mkdir(receipt, false))
        return { result: "", exitCode: 126 };
      this.events.push(`stage ${stage}`);

      return { result: "", exitCode: 0 };
    }

    if (command.startsWith("ln -T -- ") || command.startsWith("cat ")) {
      // ln/cat leave the staged payload in place; only the command's own cleanup removes it.
      const [from, to] = quoted;
      const bytes = this.files.get(from!);

      if (!this.publish(from!, to!, command.startsWith("cat "))) return { result: "", exitCode: 1 };
      this.files.set(from!, bytes!);

      if (command.includes(`rm -f '${from}'`)) this.files.delete(from!);

      if (command.includes(`rmdir -- '${dirname(from!)}'`)) {
        this.remove(dirname(from!));
        this.events.push(`cleanup ${dirname(from!)}`);
      }

      return { result: "", exitCode: 0 };
    }

    if (command.startsWith("rm -rf -- ")) {
      this.remove(quoted[0]!);
      this.events.push(`cleanup ${quoted[0]}`);

      return { result: "", exitCode: 0 };
    }

    throw new Error(`Unexpected guest command ${command.slice(0, 60)}`);
  }

  leftovers() {
    return [...this.files.keys(), ...this.directories].filter((path) =>
      path.includes(".beachside"),
    );
  }
}

test("Daytona writes create missing parent folders and leave no staging or receipts behind", async () => {
  const guest = new RecordingGuest();
  let client: Awaited<ReturnType<typeof Beachside.connect>> | undefined;

  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/api-keys/current"))
        return Response.json({ organizationId: "org" });

      if (url.pathname.endsWith("/regions"))
        return Response.json([{ id: "us", name: "us", regionType: "shared" }]);

      if (url.pathname.endsWith("/organizations/org"))
        return Response.json({ id: "org", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/sandbox/box")
        return Response.json({
          id: "box",
          name: "box",
          organizationId: "org",
          target: "us",
          state: "started",
          networkBlockAll: true,
          public: false,
          toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
        });

      if (url.pathname.endsWith("/process/execute")) {
        const request = z.object({ command: z.string() }).parse(JSON.parse(String(init?.body)));

        return Response.json(guest.execute(request.command));
      }

      if (url.pathname.endsWith("/files/upload-v2")) {
        const form =
          init?.body instanceof FormData
            ? init.body
            : await new Response(init?.body, {
                headers: { "content-type": new Headers(init?.headers).get("content-type")! },
              }).formData();

        const file = form.get("file");

        if (!(file instanceof Blob)) throw new Error("Expected multipart upload file");
        const path = url.searchParams.get("path")!;

        if (!guest.directories.has(dirname(path))) return new Response(null, { status: 404 });
        guest.files.set(path, new Uint8Array(await file.arrayBuffer()));
        guest.events.push(`upload ${path}`);

        return Response.json({ path, name: "payload", type: "file" });
      }

      if (url.pathname.endsWith("/files/download")) {
        const bytes = guest.files.get(url.searchParams.get("path")!);

        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      }

      throw new Error(`Unexpected parent fixture route ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  try {
    client = await Beachside.connect({
      adapter: createDaytonaAdapter(transport),
      config: { target: "us", networkPolicy: "blocked" },
      credentials: { apiKey: "fixture" },
    });

    const box = new AdapterSandbox(client, "box");
    const small = new Uint8Array([1, 2, 3]);
    const large = new Uint8Array(2 * 1024 * 1024).fill(7);

    await box.writeFile("/work/a/b/small.bin", small);
    await box.writeFile("/work/c/overwrite.bin", small, { overwrite: true });
    await box.writeFile("/work/d/e/large.bin", large);
    await box.copyFile("/work/a/b/small.bin", "/work/f/g/copy.bin");

    expect(guest.files.get("/work/a/b/small.bin")).toEqual(small);
    expect(guest.files.get("/work/c/overwrite.bin")).toEqual(small);
    expect(guest.files.get("/work/d/e/large.bin")?.byteLength).toBe(large.byteLength);
    expect(guest.files.get("/work/f/g/copy.bin")).toEqual(small);

    // Every write stages beside its destination, inside the parent it had to create,
    // and publishes only after that stage exists.
    for (const destination of [
      "/work/a/b/small.bin",
      "/work/c/overwrite.bin",
      "/work/d/e/large.bin",
      "/work/f/g/copy.bin",
    ]) {
      const parent = dirname(destination);

      const staged = guest.events.findIndex((event) =>
        event.startsWith(`stage ${parent}/.beachside`),
      );

      const published = guest.events.indexOf(`publish ${destination}`);

      expect(staged).toBeGreaterThanOrEqual(0);
      expect(published).toBeGreaterThan(staged);
    }

    expect(guest.leftovers()).toEqual([]);
  } finally {
    await client?.close();
  }
});
