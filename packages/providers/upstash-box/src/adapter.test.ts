import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { adapterSuite } from "@beachside/adapter/testing";
import {
  Beachside,
  Image,
  NoExitCodeError,
  OutcomeUnknownError,
  NonzeroExitError,
  type BeachsideClient,
} from "beachside";
import { createUpstashBoxAdapter, defineUpstashBoxAdapter } from "./adapter";
import { MAX_OUTPUT_BYTES } from "./exec";
import { ORIGIN, RANGE_BYTES } from "./transport";

const RequestBody = z.object({
  ephemeral: z.literal(true).optional(),
  runtime: z.string(),
  env_vars: z.record(z.string(), z.string()).optional(),
  keep_alive: z.literal(true).optional(),
  size: z.string(),
  labels: z.array(z.string()),
  ttl: z.number().optional(),
  snapshot_id: z.string().optional(),
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
      expires_at?: number;
      created_at: number;
      status: string;
    }
  >();

  const snapshots = new Map<
    string,
    { id: string; box_id: string; name: string; status: "ready"; created_at: number }
  >();

  const data = Buffer.alloc(RANGE_BYTES + 29, 0xfb);
  data.set([0, 0xff, 0x80, 0x29], RANGE_BYTES - 2);
  let creates = 0;
  let destroys = 0;
  let mkdirRequests = 0;
  let next: "normal" | "lost" | "held" = "normal";
  let ttlOverride: number | undefined;
  let failReadinessCheck = false;
  let loseDeleteResponse = false;
  let deleteReadFailed = false;
  let failDeleteRead = false;
  let failedDetailStatus = 403;
  let held: (() => void) | undefined;
  let fileVersion = "1";
  let detailClass: "native" | boolean | undefined = "native";
  const ranges: { offset: number; length: number }[] = [];
  const additionalListRows: unknown[] = [];

  const fetch = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(url, options);
      const target = new URL(request.url);
      const key = request.headers.get("X-Box-Api-Key");
      expect(key).toMatch(/^fixture/);
      expect(request.redirect).toBe("error");

      if (target.pathname === "/v2/box/snapshots" && request.method === "DELETE") {
        const { ids } = z
          .object({ ids: z.array(z.string()).length(1) })
          .parse(await request.json());

        return Response.json({ deleted: snapshots.delete(ids[0]!) ? 1 : 0 });
      }

      if (target.pathname === "/v2/box" || target.pathname === "/v2/box/from-snapshot") {
        if (request.method === "GET") {
          const label = target.searchParams.get("label");

          const rows = [...boxes.values()];

          return Response.json(
            label
              ? rows.filter((box) => box.labels.includes(label))
              : [...rows, ...additionalListRows],
          );
        }

        const body = RequestBody.parse(await request.json());

        if (target.pathname.endsWith("/from-snapshot"))
          expect(snapshots.has(body.snapshot_id ?? "")).toBe(true);
        const id = `box_${++creates}`;
        const createdAt = Math.floor(Date.now() / 1000);

        const box = {
          ...body,
          id,
          status: "idle",
          created_at: createdAt,
          expires_at: body.ttl === undefined ? undefined : createdAt + (ttlOverride ?? body.ttl),
        };

        boxes.set(id, box);
        const behavior = next;
        next = "normal";

        if (behavior === "lost") throw new Error("fixture discarded create response");

        if (behavior === "held")
          await new Promise<void>((resolve) => {
            held = resolve;
          });

        return Response.json(failReadinessCheck ? { ...box, status: "creating" } : box);
      }

      const path = target.pathname.split("/");
      const box = boxes.get(path[3] ?? "");

      if (!box) return new Response(null, { status: 404 });

      if (path[4] === "snapshots") {
        if (box.status === "deleted") return new Response(null, { status: 404 });

        if (request.method === "GET")
          return Response.json({
            snapshots: [...snapshots.values()].filter((snapshot) => snapshot.box_id === box.id),
          });
        const { name } = z.object({ name: z.string() }).parse(await request.json());
        const id = `snap_${snapshots.size + 1}`;

        const snapshot = {
          id,
          box_id: box.id,
          name,
          status: "ready" as const,
          created_at: Math.floor(Date.now() / 1000),
        };

        snapshots.set(id, snapshot);

        return Response.json(snapshot);
      }

      if (path[4] === "files") {
        if (path[5] === "stat") {
          if (target.searchParams.get("path") === "/workspace/home/new-directory")
            return new Response(null, { status: 404 });

          return Response.json({ type: "file", size: data.length, version: fileVersion });
        }

        if (path[5] === "mkdir") {
          expect(request.method).toBe("POST");
          mkdirRequests++;

          return new Response(null, { status: 500 });
        }

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

      if (request.method === "POST" && path[4] === "pause") {
        box.status = "paused";

        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && path[4] === "resume") {
        box.status = "idle";

        return new Response(null, { status: 204 });
      }

      if (request.method === "GET" && path[4] === "preview") return Response.json({ previews: [] });

      if (request.method === "POST" && path[4] === "preview") {
        const body = z
          .object({ port: z.number(), bearer_token: z.boolean(), basic_auth: z.boolean() })
          .parse(await request.json());

        return Response.json({
          url: `https://${box.id}-${body.port}.preview.box.upstash.com`,
          port: body.port,
          ...(body.bearer_token && { token: "preview-fixture-token" }),
        });
      }

      if (request.method === "DELETE") {
        destroys++;

        if (deleteReadFailed) failDeleteRead = true;
        else box.status = "deleted";

        if (loseDeleteResponse) throw new Error("fixture discarded delete response");

        return new Response(null, { status: 204 });
      }

      if (failDeleteRead) return new Response(null, { status: failedDetailStatus });

      if (failReadinessCheck) return new Response(null, { status: 503 });

      return Response.json({
        ...box,
        ephemeral: detailClass === "native" ? box.ephemeral : detailClass,
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  return {
    fetch,
    boxes,
    additionalListRows,
    data,
    ranges,
    counters: () => ({ create: creates, destroy: destroys, release: 0 }),
    mkdirRequests: () => mkdirRequests,
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
    overrideTtl(seconds: number) {
      ttlOverride = seconds;
    },
    loseReadinessEvidence() {
      failReadinessCheck = true;
    },
    denyReadAfterDelete(loseResponse: boolean) {
      deleteReadFailed = true;
      loseDeleteResponse = loseResponse;
    },
    changeFailedDetailStatus(status: number) {
      failedDetailStatus = status;
    },
    exposeTombstone(id: string) {
      const box = boxes.get(id);

      if (box) box.status = "deleted";
      failDeleteRead = false;
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
    lifecycle: { lifetimeSeconds: 60 },
  });

  const native = fixture.boxes.get(box.id);
  expect(native).toMatchObject({
    size: "medium",
    ttl: 60,
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

  for (const ttl of [899, 901]) {
    fixture.overrideTtl(ttl);
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  }
});

test("expiry acknowledgment survives a failed readiness read and fresh recovery", async () => {
  const fixture = apiFixture();
  const adapter = createUpstashBoxAdapter({ fetch: fixture.fetch });
  const credentials = { apiKey: "fixture" };
  const client = tracked(await Beachside.connect({ adapter, config: {}, credentials }));
  fixture.loseReadinessEvidence();
  let unknown;

  try {
    await client.sandboxes.create();
  } catch (error) {
    unknown = error;
  }

  if (!(unknown instanceof OutcomeUnknownError) || !unknown.reference)
    throw new Error("Expected allocation to retain a recovery reference");

  const partial = {
    code: "OUTCOME_UNKNOWN",
    outcome: { setup: { expiry: "acknowledged", readiness: "unconfirmed" } },
  };

  expect(unknown).toMatchObject(partial);
  const fresh = tracked(await Beachside.connect({ adapter, config: {}, credentials }));
  const recovery = await fresh.recover(unknown.reference);
  await expect(recovery.observe()).rejects.toMatchObject(partial);
  expect(fixture.counters().create).toBe(1);
});

test("regular boxes preserve runtime and create env, list, pause, resume, and publish protected previews", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      config: { boxKind: "regular", image: "python-alpine" },
      credentials: { apiKey: "fixture" },
    }),
  );

  await expect(
    client.sandboxes.create({ lifecycle: { lifetimeSeconds: 900 } }),
  ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(client.sandboxes.create({ env: { LD_PRELOAD: "ignored" } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(fixture.counters().create).toBe(0);

  const box = await client.sandboxes.create({
    env: { EXAMPLE: "configured" },
    labels: { job: "test" },
  });

  const native = fixture.boxes.get(box.id);
  expect(native?.runtime).toBe("python-alpine");
  expect(native?.env_vars).toEqual({ EXAMPLE: "configured" });
  expect(native?.ttl).toBeUndefined();
  expect(native?.ephemeral).toBeUndefined();
  expect((await box.inspect()).expires).toEqual({ status: "none" });

  fixture.additionalListRows.push(
    { id: "foreign_box", status: "future-status", size: "future-size", labels: 42 },
    { id: "other_box", status: "idle", size: "future-size", ephemeral: false },
    { id: "bad/id" },
  );

  const listing = await client.sandboxes.list();
  expect(listing.items).toHaveLength(3);
  expect(listing.items[1]).toMatchObject({
    id: "foreign_box",
    state: "unknown",
    reference: null,
    labels: null,
  });
  expect(listing.items[2]).toMatchObject({ id: "other_box", state: "running", reference: null });
  expect(listing.items[0]?.labels).toEqual({ job: "test" });
  const listed = listing.items[0]?.reference;
  expect(listed?.ownership).toBe("borrowed");
  expect((await client.sandboxes.get(listed!)).id).toBe(box.id);
  expect((await box.suspend()).observation.state).toBe("stopped");
  expect((await client.sandboxes.list()).items[0]?.state).toBe("stopped");
  expect((await box.resume()).observation.state).toBe("running");
  expect(await box.preview(3000)).toEqual({
    access: "protected",
    url: `https://${box.id}-3000.preview.box.upstash.com`,
    headers: { Authorization: "Bearer preview-fixture-token" },
  });
  await box.destroy();
});

test("restores a snapshot by exact ID and reapplies the selected network and TTL", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();
  const { snapshot } = await box.snapshot();

  const restored = await snapshot.restore({
    networkPolicy: "blocked",
    lifecycle: { lifetimeSeconds: 600 },
  });

  const native = fixture.boxes.get(restored.id);
  expect(native?.snapshot_id).toBe(snapshot.id);
  expect(native?.ephemeral).toBe(true);
  expect(native?.network_policy).toEqual({ mode: "deny-all" });
  expect(native?.ttl).toBe(600);
  await restored.destroy();
  await box.destroy();
  await snapshot.delete();
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

test("mkdir rejects a known file collision before dispatch and preserves uncertain outcomes", async () => {
  const fixture = apiFixture();

  const client = tracked(
    await Beachside.connect({
      adapter: createUpstashBoxAdapter({ fetch: fixture.fetch }),
      config: {},
      credentials: { apiKey: "fixture" },
    }),
  );

  const box = await client.sandboxes.create();

  await expect(
    box.makeDirectory("/workspace/home/data", { recursive: true }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", effect: "none" });
  expect(fixture.mkdirRequests()).toBe(0);

  await expect(
    box.makeDirectory("/workspace/home/new-directory", { recursive: true }),
  ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(fixture.mkdirRequests()).toBe(1);
  await box.destroy();
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

for (const acknowledged of [true, false]) {
  test(`recovers an ${acknowledged ? "acknowledged" : "unacknowledged"} delete without replay`, async () => {
    const fixture = apiFixture();
    const adapter = createUpstashBoxAdapter({ fetch: fixture.fetch });

    const client = tracked(
      await Beachside.connect({ adapter, config: {}, credentials: { apiKey: "fixture" } }),
    );

    const box = await client.sandboxes.create();
    fixture.denyReadAfterDelete(!acknowledged);
    let unknown;

    try {
      await box.destroy();
    } catch (error) {
      unknown = error;
    }

    if (!(unknown instanceof OutcomeUnknownError) || !unknown.reference)
      throw new Error("Expected deletion to retain a recovery reference");

    const fresh = tracked(
      await Beachside.connect({ adapter, config: {}, credentials: { apiKey: "fixture-current" } }),
    );

    const recovery = await fresh.recover(unknown.reference);

    for (const status of [401, 403]) {
      fixture.changeFailedDetailStatus(status);
      await expect(recovery.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    }

    fixture.changeFailedDetailStatus(404);

    if (acknowledged) {
      expect(await recovery.observe()).toMatchObject({ computeStopped: true });
    } else {
      await expect(recovery.observe()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      fixture.exposeTombstone(box.id);
      expect(await recovery.observe()).toMatchObject({ computeStopped: true });
    }

    expect(fixture.counters().destroy).toBe(1);
  });
}
