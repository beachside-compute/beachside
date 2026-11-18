import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { adapterSuite } from "@beachside/adapter/testing";
import {
  Beachside,
  Image,
  NoExitCodeError,
  NonzeroExitError,
  type BeachsideClient,
} from "beachside";
import { createUpstashBoxAdapter, defineUpstashBoxAdapter } from "./adapter";
import { MAX_OUTPUT_BYTES } from "./exec";
import { EXCLUSIVE_WRITE } from "./files";
import { ORIGIN, RANGE_BYTES } from "./transport";

const RequestBody = z.object({
  ephemeral: z.literal(true),
  runtime: z.literal("node"),
  size: z.string(),
  labels: z.array(z.string()),
  ttl: z.number(),
  network_policy: z.object({ mode: z.string() }).passthrough(),
});

const Frame = z.object({
  type: z.string(),
  argv: z.array(z.string()).optional(),
  cmd: z.string().optional(),
  cwd: z.string().optional(),
  env: z.array(z.string()).optional(),
  data: z.string().optional(),
});

const disposals: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

function tracked(client: BeachsideClient) {
  disposals.push(() => client.close());

  return client;
}

function apiFixture() {
  const boxes = new Map<
    string,
    z.output<typeof RequestBody> & {
      id: string;
      expires_at: number;
      status: string;
    }
  >();

  const data = Buffer.alloc(RANGE_BYTES + 29, 0xfb);
  data.set([0, 0xff, 0x80, 0x29], RANGE_BYTES - 2);
  let creates = 0;
  let destroys = 0;
  let next: "normal" | "lost" | "held" = "normal";
  let ttlOverride: number | undefined;
  let deleteReadFailed = false;
  let failDeleteRead = false;
  let held: (() => void) | undefined;
  let fileVersion = "1";
  let detailClass: boolean | undefined = true;
  const ranges: { offset: number; length: number }[] = [];

  const fetch = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(url, options);
      const target = new URL(request.url);
      const key = request.headers.get("X-Box-Api-Key");
      expect(key).toMatch(/^fixture/);
      expect(request.redirect).toBe("error");

      if (target.pathname === "/v2/box") {
        if (request.method === "GET") return Response.json([...boxes.values()]);
        const body = RequestBody.parse(await request.json());
        const id = `box_${++creates}`;

        const box = {
          ...body,
          id,
          status: "idle",
          expires_at: Math.floor(Date.now() / 1000) + (ttlOverride ?? body.ttl),
        };

        boxes.set(id, box);
        const behavior = next;
        next = "normal";

        if (behavior === "lost") throw new Error("fixture discarded create response");

        if (behavior === "held")
          await new Promise<void>((resolve) => {
            held = resolve;
          });

        return Response.json(box);
      }

      const path = target.pathname.split("/");
      const box = boxes.get(path[3] ?? "");

      if (!box) return new Response(null, { status: 404 });

      if (path[4] === "files") {
        if (path[5] === "stat")
          return Response.json({ type: "file", size: data.length, version: fileVersion });

        if (path[5] === "read") {
          const offset = Number(target.searchParams.get("offset"));
          const length = Number(target.searchParams.get("length"));
          ranges.push({ offset, length });
          expect(length).toBeLessThanOrEqual(RANGE_BYTES);

          return Response.json({
            content: data.subarray(offset, offset + length).toString("base64"),
          });
        }

        return new Response(null, { status: 204 });
      }

      if (request.method === "DELETE") {
        destroys++;

        if (deleteReadFailed) failDeleteRead = true;
        else box.status = "deleted";

        return new Response(null, { status: 204 });
      }

      if (failDeleteRead) return new Response(null, { status: 403 });

      return Response.json({ ...box, ephemeral: detailClass });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  return {
    fetch,
    boxes,
    data,
    ranges,
    counters: () => ({ create: creates, destroy: destroys, release: 0 }),
    loseNextCreateResponse() {
      next = "lost";
    },
    holdNextCreateResponse() {
      next = "held";
    },
    releaseHeldCreateResponse() {
      held?.();
    },
    reportDetailClass(value: boolean | undefined) {
      detailClass = value;
    },
    badTtl() {
      ttlOverride = 259_200;
    },
    denyReadAfterDelete() {
      deleteReadFailed = true;
    },
    changeVersion() {
      fileVersion = "2";
    },
  };
}

async function socketFixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  disposals.push(
    () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const received: z.infer<typeof Frame>[] = [];
  server.on("connection", (socket, request) => {
    expect(request.headers["x-box-api-key"]).toBe("fixture");
    expect(request.url).toMatch(/^\/v2\/box\/box_\d+\/exec-session$/);
    let start: z.infer<typeof Frame> | undefined;
    const stdin: Buffer[] = [];
    socket.on("message", async (raw) => {
      const frame = Frame.parse(JSON.parse(raw.toString()));
      received.push(frame);

      if (frame.type === "start") {
        start = frame;
        socket.send(JSON.stringify({ type: "started", pid: 12 }));
      }

      if (frame.type === "stdin" && frame.data) stdin.push(Buffer.from(frame.data, "base64"));

      if (frame.type !== "stdin_close") return;

      if (start?.argv?.[0] === "node" && start.argv[2] === EXCLUSIVE_WRITE) {
        const child = Bun.spawn(start.argv, {
          stdin: new Uint8Array(Buffer.concat(stdin)),
          stderr: "ignore",
        });

        socket.send(JSON.stringify({ type: "exit", code: await child.exited }));

        return;
      }

      if (start?.cmd === "combined-output") {
        socket.send(
          JSON.stringify({
            type: "stdout",
            data: Buffer.alloc(MAX_OUTPUT_BYTES - 2, 0xa5).toString("base64"),
          }),
        );
        socket.send(JSON.stringify({ type: "stderr", data: "YWJjZA==" }));
        socket.send(JSON.stringify({ type: "exit", code: 0 }));

        return;
      }

      socket.send(
        JSON.stringify({ type: "stdout", data: Buffer.concat(stdin).toString("base64") }),
      );
      socket.send(JSON.stringify({ type: "stderr", data: "ZXJy" }));

      if (start?.cmd === "disconnect") socket.close();
      else socket.send(JSON.stringify({ type: "exit", code: 7 }));
    });
  });

  return { origin: `http://127.0.0.1:${port}`, received };
}

test("provider conforms to one native mutation and read-only recovery", async () => {
  const fixture = apiFixture();
  const adapter = createUpstashBoxAdapter({ fetch: fixture.fetch });
  const alternate = defineUpstashBoxAdapter("https://fixture.invalid", { fetch: fixture.fetch });

  const report = await adapterSuite({
    adapter,
    fixture: {
      ...fixture,
      credentials: { apiKey: "fixture" },
      config: {},
      alternate: { credentials: { apiKey: "fixture-alternate" }, config: {} },
      alternateAdapter: alternate,
      createInput: { image: { kind: "prepared", value: "node" }, networkPolicy: "internet" },
      expectedReleasesPerConnection: 0,
      assertNativeRetriesDisabled() {
        // The transport sends a bare fetch request. The suite observes the lost POST below.
        expect(fixture.counters().create).toBe(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
});

test("creates at the requested size and policy, checks TTL, and reopens by exact ID", async () => {
  const fixture = apiFixture();
  const adapter = createUpstashBoxAdapter({ fetch: fixture.fetch });
  const config = { resources: { vcpus: 4 }, network: { allow: ["api.example.com", "8.8.8.8"] } };

  const client = tracked(
    await Beachside.connect({ adapter, config, credentials: { apiKey: "fixture" } }),
  );

  await expect(
    client.sandboxes.create({ labels: { invalid: "this label is too long" } }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(fixture.counters().create).toBe(0);

  const box = await client.sandboxes.create({
    labels: { app: "test" },
    lifecycle: { lifetimeSeconds: 600 },
  });

  const native = fixture.boxes.get(box.id);
  expect(native).toMatchObject({
    size: "medium",
    ttl: 600,
    network_policy: {
      mode: "custom",
      allowed_domains: ["api.example.com"],
      allowed_cidrs: ["8.8.8.8/32"],
    },
  });
  expect(native?.labels[0]).toBe("app:test");
  expect(native?.labels[1]).toMatch(/^bs:.{17}$/);
  expect((await box.inspect()).resources).toEqual({
    status: "known",
    value: { vcpus: 4, memoryMiB: 8192 },
  });
  native?.labels.pop();

  const fresh = tracked(
    await Beachside.connect({ adapter, config: {}, credentials: { apiKey: "fixture-current" } }),
  );

  const reopened = await fresh.sandboxes.get(box.reference!);
  expect(reopened.reference).toEqual(box.reference);
  expect(reopened.reference?.scope.authority.id).toBe(ORIGIN);
  await reopened.destroy();
  expect(fixture.counters().destroy).toBe(1);

  fixture.badTtl();
  await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
});

test("reopen requires evidence of an ephemeral Box when detail omits its class", async () => {
  const fixture = apiFixture();
  const adapter = createUpstashBoxAdapter({ fetch: fixture.fetch });

  const client = tracked(
    await Beachside.connect({
      adapter,
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();
  const reference = box.reference!;
  fixture.reportDetailClass(undefined);
  expect((await client.sandboxes.get(reference)).reference).toEqual(reference);

  fixture.reportDetailClass(false);
  await expect(client.sandboxes.get(reference)).rejects.toMatchObject({ code: "CONFLICT" });

  fixture.reportDetailClass(undefined);
  fixture.boxes.get(box.id)?.labels.pop();
  await expect(client.sandboxes.get(reference)).rejects.toMatchObject({ code: "CONFLICT" });

  fixture.reportDetailClass(true);
  await box.destroy();
});

test("blocked egress selects the native deny-all policy", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      credentials: { apiKey: "fixture" },
      config: { network: "blocked" },
    }),
  );

  const box = await client.sandboxes.create();
  expect(fixture.boxes.get(box.id)?.network_policy).toEqual({ mode: "deny-all" });
  await box.destroy();
});

test("rejects OCI images before allocation", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      credentials: { apiKey: "fixture" },
      config: {},
    }),
  );

  await expect(
    client.sandboxes.create({ environment: Image.oci("node:22") }),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(fixture.counters().create).toBe(0);
});

test("rejects a private egress range before sending the API key", async () => {
  let contacted = false;

  const fetch = Object.assign(
    async () => {
      contacted = true;

      return Response.json([]);
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  await expect(
    Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch }),
      credentials: { apiKey: "fixture" },
      config: { network: { allow: ["172.0.0.0/8"] } },
    }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(contacted).toBe(false);
});

test("streams binary files past the native range ceiling and rejects a changed file", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();
  const result = await box.readFile("/workspace/home/data");
  expect(Buffer.from(result).equals(fixture.data)).toBe(true);
  expect(fixture.ranges).toContainEqual({ offset: 0, length: RANGE_BYTES });
  expect(fixture.ranges).toContainEqual({ offset: RANGE_BYTES, length: 29 });
  const stream = box.readFileStream("/workspace/home/data")[Symbol.asyncIterator]();
  await stream.next();
  fixture.changeVersion();

  async function readRest() {
    for (;;) {
      if ((await stream.next()).done) return;
    }
  }

  await expect(readRest()).rejects.toMatchObject({ code: "CONFLICT" });
  await box.destroy();
});

test("live session frames preserve argv, relative cwd, env, input and exit evidence", async () => {
  const fixture = apiFixture();
  const wire = await socketFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: defineUpstashBoxAdapter(wire.origin, { fetch: fixture.fetch }),
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();

  const command = box.exec({
    command: { kind: "argv", argv: ["print", "", ";"] },
    cwd: "nested",
    env: { MODE: "a=b" },
    stdin: Uint8Array.of(0, 255),
  });

  let error;

  try {
    await command;
  } catch (reason) {
    error = reason;
  }

  if (!(error instanceof NonzeroExitError)) throw new Error("Expected the native nonzero exit");
  expect(error.result.exitCode).toBe(7);
  expect(error.result.stdout).toEqual(Uint8Array.of(0, 255));
  expect(error.result.stderrText()).toBe("err");
  expect(wire.received[0]).toMatchObject({
    argv: ["print", "", ";"],
    cwd: "/workspace/home/nested",
    env: ["MODE=a=b"],
  });

  let loss;

  try {
    await box.exec({
      command: { kind: "shell", script: "disconnect" },
      stdin: Uint8Array.of(0xff),
    });
  } catch (reason) {
    loss = reason;
  }

  if (!(loss instanceof NoExitCodeError)) throw new Error("Expected a lost native exit");
  expect(loss.result.stdout).toEqual(Uint8Array.of(0xff));
  await box.destroy();
});

test("exec truncates combined output and retains the exit code", async () => {
  const fixture = apiFixture();
  const wire = await socketFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: defineUpstashBoxAdapter(wire.origin, { fetch: fixture.fetch }),
      credentials: { apiKey: "fixture" },
      config: {},
    }),
  );

  const box = await client.sandboxes.create();
  const result = await box.exec({ command: { kind: "shell", script: "combined-output" } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.byteLength).toBe(MAX_OUTPUT_BYTES - 2);
  expect(result.stderrText()).toBe("ab");
  expect(result.truncated).toBe(true);
  await box.destroy();
});

test("default writes use exclusive creation against concurrent writers and symlinks", async () => {
  const fixture = apiFixture();
  const wire = await socketFixture();
  const directory = await mkdtemp(join(tmpdir(), "upstash-write-"));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "a file 'with quotes'");
  const other = join(directory, "link");

  const client = tracked(
    await Beachside.connect({
      adapter: defineUpstashBoxAdapter(wire.origin, { fetch: fixture.fetch }),
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();

  const writes = await Promise.allSettled([
    box.writeFile(path, Uint8Array.of(0, 255)),
    box.writeFile(path, Uint8Array.of(0, 128)),
  ]);

  expect(writes.map((write) => write.status).sort()).toEqual(["fulfilled", "rejected"]);
  const saved = await readFile(path);
  expect([255, 128]).toContain(saved[1]!);
  await symlink(path, other);
  await expect(box.writeFile(other, Uint8Array.of(5))).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await readFile(path)).toEqual(saved);
  await box.destroy();
});

test("acknowledged deletion stays uncertain when observation loses access", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();
  fixture.denyReadAfterDelete();
  await expect(box.destroy()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(fixture.counters().destroy).toBe(1);
});
