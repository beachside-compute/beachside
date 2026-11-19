import { expect, test } from "bun:test";
import { z } from "zod";
import {
  createAttemptContext,
  createObserveContext,
  isOutcome,
  outcomeKind,
  type Json,
  type ResourceReference,
  type SandboxState,
} from "@beachside/adapter";
import { snapshotHooks } from "./snapshots";
import { createTransport, ORIGIN } from "./transport";

const source = { id: "source_box" };
const scope = { authority: { kind: "service", id: ORIGIN }, partition: { region: "us-east-1" } };
const identity = { operationId: "operation", submissionId: "submission", invocationKey: "invoke" };
const snapshotsPath = "/v2/box/source_box/snapshots";
const Name = z.object({ name: z.string() });

function fixture() {
  let state: SandboxState = "running";
  let loseResponse = false;

  let record:
    | {
        id: string;
        name: string;
        box_id: string;
        created_at: number;
        status: "creating" | "ready";
      }
    | undefined;

  let checkpoint: Json | undefined;
  const calls: { method: string; path: string; body?: Json }[] = [];

  const fetcher = Object.assign(
    async (url: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(url, options);
      const path = new URL(request.url).pathname;
      const method = request.method;
      const body = request.body ? z.json().parse(await request.json()) : undefined;
      calls.push({ method, path, body });
      expect(request.headers.get("X-Box-Api-Key")).toBe("fixture-key");

      if (method === "POST" && path === snapshotsPath) {
        record = {
          id: "snapshot_1",
          name: Name.parse(body).name,
          box_id: source.id,
          created_at: 1_778_900_000,
          status: "creating",
        };

        if (loseResponse) throw new Error("fixture discarded snapshot response");

        return Response.json(record);
      }

      if (method === "GET" && path === snapshotsPath)
        return Response.json({ snapshots: record ? [record] : [] });

      if (method === "DELETE" && path === "/v2/box/snapshots") {
        const ids = z.object({ ids: z.array(z.string()) }).parse(body).ids;

        if (ids.length !== 1 || ids[0] !== record?.id) return Response.json({ deleted: 0 });
        record = undefined;

        return Response.json({ deleted: 1 });
      }

      return new Response(null, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  const hooks = snapshotHooks({
    transport: createTransport(ORIGIN, "fixture-key", fetcher),
    scope,
    boxKind: "ephemeral",
    async readSandbox() {
      return { id: source.id, state };
    },
    restoreCapabilities: {
      status: "supported",
      value: {
        networkPolicies: ["internet"],
        resources: true,
        mounts: false,
        independentLifecycle: true,
      },
    },
  });

  const signal = new AbortController().signal;
  const read = { signal, deadline: Date.now() + 30_000 };
  const tokenSchema = hooks.snapshotCapture.recovery.token;

  const attempt = createAttemptContext(
    {
      ...identity,
      signal,
      async onCheckpoint(token) {
        checkpoint = token;
      },
    },
    tokenSchema,
  );

  async function submit() {
    const prepared = await hooks.snapshotCapture.prepare({ sandbox: source, request: {} }, read);

    return hooks.snapshotCapture.submit(prepared, attempt);
  }

  return {
    calls,
    async inspect(ref: ResourceReference) {
      return hooks.snapshotInspect(ref, read);
    },
    async remove(ref: ResourceReference) {
      return hooks.snapshotDelete.submit(await hooks.snapshotDelete.prepare(ref), attempt);
    },
    submit,
    async observe() {
      return hooks.snapshotCapture.observe(
        { ...identity, sandbox: source, token: checkpoint },
        createObserveContext(read, tokenSchema),
      );
    },
    finishCapture() {
      if (!record) throw new Error("fixture has no captured snapshot");
      record.status = "ready";
    },
    loseCreateResponse() {
      loseResponse = true;
    },
    stopSource() {
      state = "stopped";
    },
  };
}

test("captures once, reads a pinned artifact, and deletes exactly its ID", async () => {
  const provider = fixture();
  const accepted = await provider.submit();

  if (!isOutcome(accepted)) throw new Error("Expected asynchronous snapshot capture");
  expect(outcomeKind(accepted)).toBe("pending");
  provider.finishCapture();
  const captured = await provider.observe();

  if (!captured || isOutcome(captured)) throw new Error("Expected completed snapshot capture");
  expect(captured).toMatchObject({
    snapshot: {
      reference: { nativeId: "snapshot_1", ownership: "verified-created" },
      preserve: "filesystem",
      restoreExecution: "fresh",
      state: "ready",
    },
    source: { state: "running", connections: "unknown" },
  });

  const reference = captured.snapshot.reference;
  expect(await provider.inspect(reference)).toEqual(captured.snapshot);
  expect(await provider.remove(reference)).toEqual({ deleted: true, reference });
  await expect(provider.inspect(reference)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(provider.calls.filter((call) => call.method !== "GET")).toEqual([
    {
      method: "POST",
      path: snapshotsPath,
      body: { name: expect.stringMatching(/^beachside-[a-f0-9]{24}$/) },
    },
    { method: "DELETE", path: "/v2/box/snapshots", body: { ids: ["snapshot_1"] } },
  ]);
});

test("observes a lost capture by exact attempt name and preserves the snapshot if source changed", async () => {
  const provider = fixture();
  provider.loseCreateResponse();
  await provider.submit();
  provider.finishCapture();
  provider.stopSource();
  const observed = await provider.observe();

  if (!observed || !isOutcome(observed)) throw new Error("Expected a partial capture outcome");
  expect(outcomeKind(observed)).toBe("unknown");
  expect(observed).toMatchObject({
    outcome: {
      kind: "snapshot_capture",
      status: "partial",
      snapshot: { nativeId: "snapshot_1" },
      source: { state: "stopped" },
    },
  });
  expect(provider.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
