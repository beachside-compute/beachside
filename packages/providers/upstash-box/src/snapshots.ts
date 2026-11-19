import { createHash } from "node:crypto";
import {
  AdapterCheckpointError,
  AdapterError,
  Preserve,
  assertResourceScope,
  listedTime,
  resolveSnapshot,
  validateResourceReference,
  type AdapterSession,
  type OperationOutcome,
  type ReadContext,
  type ResourceReference,
  type RestoreCapabilities,
  type Sandbox,
  type SandboxState,
  type Scope,
  type SnapshotInfo,
  type SnapshotProfile,
  type Support,
} from "@beachside/adapter";
import { z } from "zod";
import { boxPath } from "./files";
import { definitiveRefusal, type Transport } from "./transport";

const PROVIDER = "upstash-box";
const POLL_MS = 2_000;
const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const SourceClass = z.enum(["ephemeral", "regular"]);
const SourceState = z.enum(["running", "stopped"]);
const Consistency = z.enum(["unknown", "caller-quiesced"]);
const Name = z.string().regex(/^beachside-[0-9a-f]{24}$/);

const NativeSnapshot = z.object({
  id: Id,
  box_id: Id,
  name: z.string().min(1).max(512),
  status: z.enum(["creating", "ready", "error", "deleted"]),
  created_at: z.number().int().positive().max(253_402_300_799),
});

const SnapshotIdentity = NativeSnapshot.pick({ id: true, box_id: true, name: true });

type NativeSnapshot = z.infer<typeof NativeSnapshot>;

const SnapshotList = z.object({ snapshots: z.array(NativeSnapshot) });

const SnapshotHistory = z.strictObject({
  sourceId: Id,
  sourceClass: SourceClass,
  consistency: Consistency,
});

type SnapshotHistory = z.infer<typeof SnapshotHistory>;

const CaptureToken = SnapshotHistory.extend({
  id: Id.optional(),
  name: Name,
  sourceState: SourceState,
});

type CaptureToken = z.infer<typeof CaptureToken>;

// Upstash documents capturing running or paused boxes and restoring a fresh filesystem.
// The server does not document the effect on live processes, so advertise a conservative bound.
const profile: SnapshotProfile = {
  id: "upstash-filesystem",
  preserve: Preserve.FILESYSTEM,
  sourceStates: SourceState.options,
  interruption: "stop",
  sourceAfter: "unchanged",
  connections: "unknown",
  consistency: "unknown",
  restoreExecution: "fresh",
  mountHandling: "none",
};

const capture = {
  preserve: profile.preserve,
  interruption: profile.interruption,
  restoreExecution: profile.restoreExecution,
};

const profileSupport = {
  status: "supported" as const,
  value: { profiles: [profile], defaultProfileId: profile.id },
};

const noVolumes = { status: "unsupported" as const, reason: "Upstash Box has no native volumes" };

type SnapshotHooksOptions = {
  transport: Transport;
  scope: Scope;
  boxKind: z.infer<typeof SourceClass>;
  readSandbox(sandbox: Sandbox, ctx: ReadContext): Promise<{ id: string; state: SandboxState }>;
  restoreCapabilities: Support<RestoreCapabilities>;
};

function captureName(submission: string) {
  return `beachside-${createHash("sha256").update(submission).digest("hex").slice(0, 24)}`;
}

function snapshotsPath(source: string) {
  return `${boxPath(source)}/snapshots`;
}

export function snapshotHooks(options: SnapshotHooksOptions) {
  const { transport, scope, boxKind, readSandbox, restoreCapabilities } = options;

  const restore =
    restoreCapabilities.status === "supported"
      ? restoreCapabilities.value
      : {
          networkPolicies: [],
          resources: false,
          mounts: false,
          independentLifecycle: false,
        };

  function checkReference(reference: ResourceReference) {
    assertResourceScope(reference, { provider: PROVIDER, scope });
    const id = Id.safeParse(reference.nativeId);

    if (reference.kind !== "snapshot" || !id.success)
      throw new AdapterError("INVALID_ARGUMENT", "Invalid Upstash Box snapshot reference");

    return id.data;
  }

  async function read(source: string, signal: AbortSignal) {
    const response = SnapshotList.safeParse(await transport.json(snapshotsPath(source), signal));

    if (!response.success || response.data.snapshots.some((entry) => entry.box_id !== source))
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid snapshot inventory");

    return response.data.snapshots;
  }

  function referenceFor(id: string, token: CaptureToken) {
    const { sourceId, sourceClass, consistency } = token;

    return validateResourceReference({
      version: 1,
      kind: "snapshot",
      provider: PROVIDER,
      scope,
      nativeId: id,
      ownership: "verified-created",
      history: { sourceId, sourceClass, consistency },
    });
  }

  function info(
    reference: ResourceReference,
    history: SnapshotHistory,
    native?: NativeSnapshot,
  ): SnapshotInfo {
    const state = native?.status;

    return {
      reference,
      preserve: Preserve.FILESYSTEM,
      restoreExecution: "fresh",
      consistency: history.consistency,
      source: { id: history.sourceId, class: history.sourceClass },
      state: state === "creating" || state === "ready" ? state : "unknown",
      createdAt: native ? listedTime(native.created_at * 1000) : null,
      expiration: "unknown",
      excludedPaths: null,
      mounts: [],
      mountHandling: "none",
      restore: {
        networkPolicies: restore.networkPolicies,
        resources: restore.resources,
        mounts: restore.mounts,
        independentLifecycle: restore.independentLifecycle,
      },
      dependencies: [],
      nativeDependencies: null,
      labels: null,
    };
  }

  function unknownCapture(token: CaptureToken, native?: NativeSnapshot): OperationOutcome {
    const id = native?.id ?? token.id;

    return {
      kind: "snapshot_capture",
      status: native?.status === "ready" ? "partial" : "unknown",
      snapshot: id ? referenceFor(id, token) : undefined,
      capture: native?.status === "ready" ? capture : undefined,
    };
  }

  async function sourceObservation(sandbox: Sandbox, ctx: ReadContext) {
    try {
      const source = await readSandbox(sandbox, ctx);

      return source.id === sandbox.id ? source.state : "unknown";
    } catch {
      return "unknown";
    }
  }

  async function captured(
    token: CaptureToken,
    native: NativeSnapshot,
    sandbox: Sandbox,
    ctx: ReadContext,
  ) {
    const state = await sourceObservation(sandbox, ctx);
    const snapshot = info(referenceFor(native.id, token), token, native);
    const source = { state, connections: "unknown" as const, observedAt: new Date().toISOString() };

    if (state !== token.sourceState)
      return {
        success: false as const,
        outcome: {
          kind: "snapshot_capture" as const,
          status: "partial" as const,
          snapshot: referenceFor(native.id, token),
          capture,
          source,
        },
      };

    return {
      success: true as const,
      value: { snapshot, capture, source, retainedResources: [snapshot.reference] },
    };
  }

  return {
    snapshotProfiles: async () => profileSupport,
    resourceCapabilities: async () => ({
      restore: restoreCapabilities,
      volumes: noVolumes,
      mounts: noVolumes,
    }),
    snapshotCapture: {
      recovery: { version: 1, token: CaptureToken },
      async prepare(input, ctx) {
        const source = await readSandbox(input.sandbox, ctx);
        const plan = resolveSnapshot(profileSupport, input.request, source.state);

        if (source.id !== input.sandbox.id)
          throw new AdapterError("CONFLICT", "Upstash Box returned a different snapshot source");

        if (plan.status !== "supported") throw new AdapterError("UNSUPPORTED", plan.reason);

        if (input.request.retention?.cleanupAfterSeconds !== undefined)
          throw new AdapterError("UNSUPPORTED", "Upstash Box does not schedule snapshot cleanup");

        return {
          ...input,
          expectation: { profile: plan.value.profile, sourceState: plan.value.sourceState },
        };
      },
      async submit(input, ctx) {
        const sourceState = SourceState.safeParse(input.expectation?.sourceState);
        const id = Id.safeParse(input.sandbox.id);

        if (!sourceState.success || !id.success)
          return ctx.reject("INVALID_ARGUMENT", "Upstash Box snapshot source is unconfirmed");

        const token: CaptureToken = {
          sourceId: id.data,
          sourceClass: boxKind,
          sourceState: sourceState.data,
          consistency: input.request.consistency ?? "unknown",
          name: captureName(ctx.submissionId),
        };

        await ctx.checkpoint(token);

        let response: unknown;

        try {
          response = await transport.json(snapshotsPath(token.sourceId), ctx.signal, "POST", {
            name: token.name,
          });
        } catch (error) {
          if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

          return ctx.pending(token, { pollAfterMs: POLL_MS });
        }

        const identity = SnapshotIdentity.safeParse(response);

        if (
          !identity.success ||
          identity.data.name !== token.name ||
          identity.data.box_id !== token.sourceId
        )
          return ctx.pending(token, { pollAfterMs: POLL_MS });
        const acknowledged = { ...token, id: identity.data.id };
        const native = NativeSnapshot.safeParse(response);

        try {
          await ctx.checkpoint(acknowledged);
        } catch (error) {
          if (error instanceof AdapterCheckpointError)
            error.outcome = unknownCapture(acknowledged, native.success ? native.data : undefined);
          throw error;
        }

        if (!native.success || native.data.status === "creating")
          return ctx.pending(acknowledged, { pollAfterMs: POLL_MS });

        if (native.data.status !== "ready")
          return ctx.unknown(
            "Upstash Box did not complete snapshot capture",
            unknownCapture(acknowledged, native.data),
          );

        const result = await captured(acknowledged, native.data, input.sandbox, {
          signal: ctx.signal,
          deadline: Date.now() + 30_000,
        });

        return result.success
          ? result.value
          : ctx.unknown("Snapshot is ready but source state is unconfirmed", result.outcome);
      },
      async observe(attempt, ctx) {
        const parsed = CaptureToken.safeParse(attempt.token);

        if (
          !parsed.success ||
          parsed.data.sourceId !== attempt.sandbox?.id ||
          parsed.data.name !== captureName(attempt.submissionId)
        )
          return null;
        const token = parsed.data;
        let snapshots: NativeSnapshot[];

        try {
          snapshots = await read(token.sourceId, ctx.signal);
        } catch {
          return ctx.unknown(
            "Upstash Box snapshot state could not be observed",
            unknownCapture(token),
          );
        }

        const matching = snapshots.filter(
          (entry) => entry.name === token.name && (!token.id || token.id === entry.id),
        );

        if (matching.length > 1)
          return ctx.unknown(
            "Upstash Box returned ambiguous snapshot identity",
            unknownCapture(token),
          );
        const snapshot = matching[0];

        if (!snapshot)
          return ctx.unknown(
            "Upstash Box did not return the submitted snapshot",
            unknownCapture(token),
          );

        if (snapshot.status === "creating")
          return ctx.pending({ ...token, id: snapshot.id }, { pollAfterMs: POLL_MS });

        if (snapshot.status !== "ready")
          return ctx.unknown(
            "Upstash Box did not complete snapshot capture",
            unknownCapture(token, snapshot),
          );
        const result = await captured(token, snapshot, attempt.sandbox, ctx);

        return result.success
          ? result.value
          : ctx.unknown("Snapshot is ready but source state is unconfirmed", result.outcome);
      },
    },
    async snapshotInspect(reference, ctx) {
      const id = checkReference(reference);
      const history = SnapshotHistory.safeParse(reference.history);

      if (!history.success)
        throw new AdapterError(
          "UNSUPPORTED",
          "Upstash requires the source Box ID to inspect a snapshot",
        );
      const snapshots = await read(history.data.sourceId, ctx.signal);
      const snapshot = snapshots.find((entry) => entry.id === id && entry.status !== "deleted");

      if (!snapshot) throw new AdapterError("NOT_FOUND", "Upstash Box snapshot is unavailable");

      return info(reference, history.data, snapshot);
    },
    snapshotDelete: {
      async prepare(reference) {
        checkReference(reference);

        return reference;
      },
      async submit(reference, ctx) {
        const id = checkReference(reference);
        let response: unknown;

        try {
          response = await transport.json("/v2/box/snapshots", ctx.signal, "DELETE", { ids: [id] });
        } catch (error) {
          if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

          return ctx.unknown("Upstash Box snapshot deletion could not be confirmed");
        }

        const result = z.object({ deleted: z.literal(1) }).safeParse(response);

        return result.success
          ? { deleted: true as const, reference }
          : ctx.unknown("Upstash Box did not confirm deleting the exact snapshot");
      },
    },
  } satisfies Pick<
    AdapterSession,
    | "snapshotProfiles"
    | "resourceCapabilities"
    | "snapshotCapture"
    | "snapshotInspect"
    | "snapshotDelete"
  >;
}
