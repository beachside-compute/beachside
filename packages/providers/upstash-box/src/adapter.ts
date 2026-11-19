import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  AllowNetworkSetting,
  DEFAULT_LIFETIME_SECONDS,
  listedLabels,
  listedTime,
  validateResourceReference,
  type InventoryInput,
  type ReadContext,
  type RecoveryAttempt,
  type ObserveContext,
  type SnapshotRestoreInput,
  type RestoreCapabilities,
  type Support,
  ResourceMinimums,
  allowlistConfig,
  allowlistFromCanonical,
  assertResourceScope,
  defineAdapter,
  networkPolicyName,
  parseEgressAllowlist,
  sandboxReference,
  smallestSize,
  throwAllowlistError,
  unknownSandboxFacts,
  type AdapterSession,
  type AttemptContext,
  type CreateInput,
  type DestroyInput,
  type ExecInput,
  type OperationOutcome,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type Scope,
} from "@beachside/adapter";
import { createExec, ExecLoss, MAX_OUTPUT_BYTES } from "./exec";
import { boxFiles, boxPath } from "./files";
import { createProcesses } from "./process";
import { snapshotHooks } from "./snapshots";
import { regularHooks } from "./regular";
import { BoxHttpError, createTransport, definitiveRefusal, ORIGIN } from "./transport";

const PROVIDER = "upstash-box";
const REGION = "us-east-1";
const IMAGE = "node";

const LIFETIME = { minSeconds: 1, maxSeconds: 259_200 };

const Runtime = z.enum([
  "node",
  "python",
  "golang",
  "ruby",
  "rust",
  "node-alpine",
  "python-alpine",
  "golang-alpine",
  "ruby-alpine",
  "rust-alpine",
]);

const BoxKind = z.enum(["ephemeral", "regular"]);

type BoxKind = z.infer<typeof BoxKind>;

const RESERVED_ENV = new Set([
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "UPSTASH_BOX_ID",
  "UPSTASH_BOX_NAME",
  "UPSTASH_BOX_AGENT",
  "UPSTASH_BOX_RUNTIME",
]);

const SIZES = [
  { name: "small", vcpus: 2, memoryMiB: 4096 },
  { name: "medium", vcpus: 4, memoryMiB: 8192 },
  { name: "large", vcpus: 8, memoryMiB: 16384 },
] as const;

const Size = z.enum(["small", "medium", "large"]);

const Setup = z.strictObject({
  image: Runtime.default(IMAGE),
  boxKind: BoxKind.default("ephemeral"),
  keepAlive: z.boolean().default(false),
  preview: z
    .strictObject({ access: z.enum(["protected", "public"]).default("protected") })
    .optional(),
  network: z.union([z.enum(["internet", "blocked"]), AllowNetworkSetting]).default("internet"),
  resources: ResourceMinimums.optional(),
  lifecycle: z
    .strictObject({
      lifetimeSeconds: z
        .number()
        .int()
        .min(LIFETIME.minSeconds)
        .max(LIFETIME.maxSeconds)
        .optional(),
    })
    .default({}),
});

const Credentials = z.strictObject({
  apiKey: z
    .string()
    .regex(/^[!-~]+$/)
    .max(1024),
});

const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const NativeLabel = z.string().regex(/^[a-zA-Z0-9._:-]{1,20}$/);
const CorrelationPrefix = "bs:";

const Policy = z.object({
  mode: z.enum(["allow-all", "deny-all", "custom"]),
  allowed_domains: z.array(z.string()).max(256).optional(),
  allowed_cidrs: z.array(z.string()).max(256).optional(),
  denied_cidrs: z.array(z.string()).max(256).optional(),
});

type Policy = z.infer<typeof Policy>;

const Detail = z.object({
  id: Id,
  ephemeral: z.boolean().optional(),
  keep_alive: z.boolean().optional(),
  created_at: z.number().int().positive().safe().optional(),
  status: z.enum(["creating", "idle", "running", "paused", "error", "deleted"]),
  runtime: z.string().optional(),
  size: Size.optional(),
  labels: z.array(NativeLabel).max(5).optional(),
  expires_at: z.number().int().positive().max(8_640_000_000_000).optional().catch(undefined),
  network_policy: Policy.optional(),
});

type Detail = z.infer<typeof Detail>;

const ListEntry = z.object({
  id: Id,
  ephemeral: Detail.shape.ephemeral.catch(undefined),
  keep_alive: Detail.shape.keep_alive.catch(undefined),
  created_at: Detail.shape.created_at.catch(undefined),
  status: Detail.shape.status.optional().catch(undefined),
  labels: Detail.shape.labels.catch(undefined),
  expires_at: Detail.shape.expires_at,
});

const Preparation = z.strictObject({
  size: Size,
  ttl: z.number().int().min(LIFETIME.minSeconds).max(LIFETIME.maxSeconds).optional(),
  runtime: Runtime,
  env_vars: z.record(z.string(), z.string()).optional(),
  snapshot_id: Id.optional(),
  network_policy: Policy,
  labels: z.array(NativeLabel).max(4),
});

type Preparation = z.infer<typeof Preparation>;

const CreateToken = z.strictObject({
  id: Id,
  size: Size,
  labels: z.array(NativeLabel).max(4),
  policy: z.string().regex(/^[a-f0-9]{64}$/),
  ttl: Preparation.shape.ttl,
  expiryAcknowledged: z.literal(true).optional(),
  runtime: Runtime,
  boxKind: BoxKind,
  keepAlive: z.boolean(),
  restore: z.boolean().optional(),
});

type CreateToken = z.infer<typeof CreateToken>;

const DestroyToken = z.strictObject({ id: Id, acknowledged: z.boolean() });

export type UpstashBoxAdapterOptions = {
  /** Native transport overrides for host-owned tests. */
  fetch?: typeof fetch;
};

function marker(submissionId: string, kind?: BoxKind) {
  const prefix = kind
    ? `${CorrelationPrefix}${kind === "ephemeral" ? "e" : "r"}:`
    : CorrelationPrefix;

  return (
    prefix +
    createHash("sha256")
      .update(submissionId)
      .digest("base64url")
      .slice(0, 20 - prefix.length)
  );
}

function nativeKind(
  box: Pick<Detail, "ephemeral" | "expires_at" | "labels" | "keep_alive">,
): BoxKind | undefined {
  if (box.ephemeral !== undefined) return box.ephemeral ? "ephemeral" : "regular";

  if (box.expires_at !== undefined) return "ephemeral";
  const candidate = box.labels?.find((label) => /^bs:[er]:[A-Za-z0-9_-]{15}$/.test(label));

  if (candidate) return candidate.startsWith("bs:e:") ? "ephemeral" : "regular";

  if (box.keep_alive === true) return "regular";

  return undefined;
}

const CreationReceipt = z.object({ submission: z.string().min(1).max(128) });

function hasClassEvidence(box: Detail, ref: SandboxReference, kind: BoxKind) {
  // Explicit contradictory provider evidence takes precedence over the historical receipt.
  if (box.ephemeral !== undefined) return nativeKind(box) === kind;

  if (ref.ownership === "borrowed") return nativeKind(box) === kind;

  if (ref.ownership !== "verified-created" || !ref.receipt || !box.labels) return false;

  try {
    const receipt = CreationReceipt.safeParse(JSON.parse(ref.receipt));

    return (
      receipt.success &&
      (box.labels.includes(marker(receipt.data.submission, kind)) ||
        (kind === "ephemeral" && box.labels.includes(marker(receipt.data.submission))))
    );
  } catch {
    return false;
  }
}

function nativeLabels(labels: CreateInput["labels"]): string[] {
  const result = Object.entries(labels ?? {}).map(([key, value]) => {
    const label = `${key}:${value}`;

    if (
      !key ||
      key.includes(":") ||
      label.startsWith(CorrelationPrefix) ||
      !NativeLabel.safeParse(label).success
    )
      throw new AdapterError(
        "UNSUPPORTED",
        "Upstash Box labels must fit its 20-character key:value format",
      );

    return label;
  });

  if (result.length > 4)
    throw new AdapterError("UNSUPPORTED", "Upstash Box supports at most four user labels");

  return result;
}

function ipv4Range(cidr: string) {
  const [address = "", bits = "32"] = cidr.split("/");
  const start = address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);

  return { start, end: start + 2 ** (32 - Number(bits)) - 1 };
}

// Upstash blocks private ranges even when they were explicitly included in a custom policy.
const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(ipv4Range);

function rejectPrivateRanges(cidrs: readonly string[]) {
  for (const cidr of cidrs) {
    const range = ipv4Range(cidr);

    if (PRIVATE_RANGES.some((blocked) => range.start <= blocked.end && blocked.start <= range.end))
      throw new AdapterError("UNSUPPORTED", `Upstash Box cannot allow private IPv4 range ${cidr}`);
  }
}

function policyDigest(policy: Policy = { mode: "allow-all" }) {
  const entries = [...(policy.allowed_domains ?? []), ...(policy.allowed_cidrs ?? [])];

  if (policy.denied_cidrs?.length || (policy.mode === "custom") !== entries.length > 0)
    throw new AdapterError("CONFLICT", "Upstash Box returned an unexpected network policy");
  const domains = policy.allowed_domains ?? [];
  const ranges = policy.allowed_cidrs ?? [];

  if (
    domains.some((entry) => parseEgressAllowlist([entry]).hosts.length === 0) ||
    ranges.some((entry) => parseEgressAllowlist([entry]).cidrs.length === 0)
  )
    throw new AdapterError("CONFLICT", "Upstash Box returned a misplaced network entry");
  const canonical = entries.length ? parseEgressAllowlist(entries).canonical : "";

  return createHash("sha256")
    .update(JSON.stringify([policy.mode, canonical]))
    .digest("hex");
}

function hasRequestedExpiry(detail: Detail, token: CreateToken, submissionId: string) {
  return (
    token.ttl !== undefined &&
    detail.created_at !== undefined &&
    detail.expires_at !== undefined &&
    detail.expires_at - detail.created_at === token.ttl &&
    nativeKind(detail) === "ephemeral" &&
    detail.labels?.includes(marker(submissionId, token.boxKind)) === true
  );
}

function ready(detail: Detail, token: CreateToken, submissionId: string) {
  return (
    nativeKind(detail) === token.boxKind &&
    (detail.status === "idle" || detail.status === "running") &&
    detail.runtime === token.runtime &&
    detail.size === token.size &&
    (token.boxKind === "regular" ||
      (hasRequestedExpiry(detail, token, submissionId) &&
        (detail.expires_at ?? 0) * 1000 > Date.now())) &&
    Boolean(detail.keep_alive) === token.keepAlive &&
    detail.labels?.includes(marker(submissionId, token.boxKind)) &&
    token.labels.every((label) => detail.labels?.includes(label)) &&
    token.policy === policyDigest(detail.network_policy)
  );
}

function sandboxState(status: Detail["status"] | undefined): SandboxInfo["state"] {
  const state = {
    idle: "running",
    running: "running",
    paused: "stopped",
    deleted: "destroyed",
    creating: "creating",
    error: "unknown",
  } as const;

  return status === undefined ? "unknown" : state[status];
}

function sandboxInfo(detail: Detail, reference: SandboxReference | null): SandboxInfo {
  const size = SIZES.find((entry) => entry.name === detail.size);

  return {
    ...unknownSandboxFacts(),
    reference,
    state: sandboxState(detail.status),
    nativeState: detail.status,
    observedAt: new Date().toISOString(),
    ...(nativeKind(detail) === "regular" && { expires: { status: "none" } }),
    ...(detail.expires_at && {
      expires: {
        status: "known",
        action: "destroy",
        scope: "sandbox",
        at: new Date(detail.expires_at * 1000).toISOString(),
      },
    }),
    ...(size && {
      resources: {
        status: "known",
        value: { vcpus: size.vcpus, memoryMiB: size.memoryMiB },
      },
    }),
  };
}

export function createUpstashBoxAdapter(options: UpstashBoxAdapterOptions = {}) {
  return defineUpstashBoxAdapter(ORIGIN, options);
}

// The production entrypoint fixes the credential-bearing origin. Fixtures use an alternate service
// origin to exercise the scope contract without adding a routing setting to the public adapter.
export function defineUpstashBoxAdapter(origin: string, options: UpstashBoxAdapterOptions) {
  return defineAdapter({
    name: PROVIDER,
    displayName: "Upstash Box",
    config: Setup,
    credentials: Credentials,
    setup: {
      credentials: {
        apiKey: {
          env: "UPSTASH_BOX_API_KEY",
          description: "A Box API key from the Upstash Console.",
          url: "https://console.upstash.com/",
        },
      },
      config: {
        image: { env: "UPSTASH_BOX_IMAGE", choices: Runtime.options },
        boxKind: { env: "UPSTASH_BOX_KIND", choices: BoxKind.options },
        network: { env: "UPSTASH_BOX_NETWORK", choices: ["internet"] },
      },
      docs: "https://beachside.run/docs/providers/upstash-box/",
    },
    async connect({ config, credentials, host }) {
      const ephemeral = config.boxKind === "ephemeral";

      if (ephemeral && (config.keepAlive || config.preview))
        throw new AdapterError(
          "UNSUPPORTED",
          "Upstash Box keep-alive and previews require a regular box",
        );

      if (!ephemeral && config.lifecycle.lifetimeSeconds !== undefined)
        throw new AdapterError("UNSUPPORTED", "Upstash regular boxes have no native lifetime");

      if (config.network === "blocked")
        throw new AdapterError(
          "UNSUPPORTED",
          "Upstash Box deny-all failed live egress verification",
        );

      const size = smallestSize("Upstash Box", SIZES, config.resources ?? {});
      const parsedAllow = allowlistConfig("Upstash Box", config.network);
      throwAllowlistError(parsedAllow);
      const allowlist = parsedAllow.allowlist && allowlistFromCanonical(parsedAllow.allowlist);

      if (allowlist) rejectPrivateRanges(allowlist.cidrs);

      const defaultPolicy = networkPolicyName(config.network);
      const policies = allowlist ? ["allow"] : ["internet"];

      const scope: Scope = {
        authority: { kind: "service", id: origin },
        partition: { region: REGION },
      };

      const transport = createTransport(
        origin,
        credentials.apiKey,
        options.fetch ?? globalThis.fetch,
      );

      const live = createExec(origin, credentials.apiKey);
      host.onClose(live.close);
      const processes = createProcesses(origin, credentials.apiKey);
      host.onClose(processes.close);
      // Verify authorization with a filtered read. The label is reserved and unique to this probe.
      await transport.empty(
        `/v2/box?label=${encodeURIComponent(marker(crypto.randomUUID()))}`,
        host.signal,
        "GET",
      );

      function locator(box: Sandbox) {
        const id = Id.safeParse(box.id);

        if (!id.success) throw new AdapterError("INVALID_ARGUMENT", "Invalid Upstash Box ID");

        if (box.reference) {
          assertResourceScope(box.reference, { provider: PROVIDER, scope });

          if (box.reference.nativeId !== id.data)
            throw new AdapterError("CONFLICT", "Upstash Box ID differs from the saved reference");
        }

        return id.data;
      }

      async function detail(id: string, signal: AbortSignal) {
        const raw = await transport.json(boxPath(id), signal);
        const result = Detail.safeParse(raw);

        if (!result.success) throw new AdapterError("UNAVAILABLE", "Upstash Box detail is invalid");

        if (result.data.id !== id)
          throw new AdapterError("CONFLICT", "Upstash Box returned a different ID");

        return result.data;
      }

      function reference(id: string, attempt: { operationId: string; submissionId: string }) {
        return sandboxReference(PROVIDER, scope, id, {
          operation: attempt.operationId,
          submission: attempt.submissionId,
        });
      }

      function partial(
        ref: SandboxReference,
        acknowledged: boolean,
        restore: boolean,
      ): OperationOutcome {
        if (restore)
          return { kind: "snapshot_restore", status: "unknown", sandbox: ref, mounts: [] };

        return {
          kind: "create",
          status: "partial",
          sandbox: ref,
          setup: {
            expiry: acknowledged ? "acknowledged" : "unconfirmed",
            readiness: "unconfirmed",
          },
        };
      }

      async function deleted(id: string, acknowledged: boolean, signal: AbortSignal) {
        try {
          return (await detail(id, signal)).status === "deleted";
        } catch (error) {
          // An authorized pre-delete read and a successful DELETE establish the context for a 404.
          return acknowledged && error instanceof BoxHttpError && error.status === 404;
        }
      }

      function prepare(
        input: CreateInput,
        snapshotId?: string,
        selectedSize = size.name,
      ): Preparation {
        const runtime = Runtime.safeParse(input.image.value);

        if (
          input.image.kind !== "prepared" ||
          !runtime.success ||
          (input.region !== undefined && input.region !== REGION) ||
          input.requirements ||
          input.mounts?.length
        )
          throw new AdapterError(
            "UNSUPPORTED",
            "Upstash Box requires a prepared runtime in us-east-1 without mounts or state requirements",
          );

        if (!ephemeral && input.lifetimeSeconds !== undefined)
          throw new AdapterError("UNSUPPORTED", "Upstash regular boxes have no native lifetime");

        const reserved = Object.keys(input.env ?? {}).find((key) => RESERVED_ENV.has(key));

        if (reserved)
          throw new AdapterError(
            "UNSUPPORTED",
            `Upstash Box reserves environment variable ${reserved}`,
          );

        if (!policies.includes(input.networkPolicy))
          throw new AdapterError("UNSUPPORTED", "Unsupported Upstash Box network policy");

        const network_policy: Policy =
          input.networkPolicy === "allow" && allowlist
            ? {
                mode: "custom",
                allowed_domains: [...allowlist.hosts],
                allowed_cidrs: [...allowlist.cidrs],
              }
            : { mode: "allow-all" };

        return {
          size: selectedSize,
          ttl: ephemeral
            ? (input.lifetimeSeconds ??
              config.lifecycle.lifetimeSeconds ??
              DEFAULT_LIFETIME_SECONDS)
            : undefined,
          runtime: runtime.data,
          env_vars: input.env,
          network_policy,
          labels: nativeLabels(input.labels),
          snapshot_id: snapshotId,
        };
      }

      async function submitAllocation(prepared: Preparation, ctx: AttemptContext<CreateToken>) {
        let raw: unknown;

        try {
          raw = await transport.json(
            prepared.snapshot_id ? "/v2/box/from-snapshot" : "/v2/box",
            ctx.signal,
            "POST",
            {
              ...prepared,
              ...(ephemeral ? { ephemeral: true } : config.keepAlive ? { keep_alive: true } : {}),
              labels: [...prepared.labels, marker(ctx.submissionId, config.boxKind)],
            },
          );
        } catch (error) {
          if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

          return ctx.unknown("Upstash Box did not confirm allocation");
        }

        const parsed = z.object({ id: Id }).safeParse(raw);

        if (!parsed.success) return ctx.unknown("Upstash Box returned no usable allocation ID");
        const { id } = parsed.data;
        const ref = reference(id, ctx);

        const token: CreateToken = {
          id,
          size: prepared.size,
          labels: prepared.labels,
          policy: policyDigest(prepared.network_policy),
          runtime: prepared.runtime,
          boxKind: config.boxKind,
          keepAlive: config.keepAlive,
          ...(prepared.snapshot_id && { restore: true }),
          ...(prepared.ttl !== undefined && { ttl: prepared.ttl }),
        };

        const native = Detail.safeParse(raw);

        const hasExpiry =
          native.success && hasRequestedExpiry(native.data, token, ctx.submissionId);

        if (hasExpiry) token.expiryAcknowledged = true;

        try {
          await ctx.checkpoint(token);
        } catch (error) {
          if (error instanceof AdapterCheckpointError)
            error.outcome = partial(ref, hasExpiry, !!token.restore);
          throw error;
        }

        try {
          if (native.success && ready(native.data, token, ctx.submissionId))
            return { id, reference: ref, state: "running" as const };
        } catch {
          // A malformed policy cannot confirm the requested guarantee.
        }

        return observeAllocation(
          {
            operationId: ctx.operationId,
            submissionId: ctx.submissionId,
            sandbox: undefined,
            token,
          },
          {
            signal: ctx.signal,
            deadline: Date.now() + 30_000,
            pending: ctx.pending,
            unknown: ctx.unknown,
          },
        );
      }

      async function observeAllocation(
        attempt: RecoveryAttempt<CreateToken, undefined>,
        ctx: ObserveContext<CreateToken>,
      ) {
        const token = attempt.token;

        if (!token) return ctx.unknown("Upstash Box allocation did not return an ID");
        const ref = reference(token.id, attempt);
        let hasExpiry = token.expiryAcknowledged === true;

        try {
          const box = await detail(token.id, ctx.signal);
          hasExpiry ||= hasRequestedExpiry(box, token, attempt.submissionId);

          if (ready(box, token, attempt.submissionId))
            return { id: token.id, reference: ref, state: "running" as const };

          if (box.status === "creating") {
            return ctx.pending(hasExpiry ? { ...token, expiryAcknowledged: true } : token, {
              pollAfterMs: 2_000,
            });
          }

          return ctx.unknown(
            "Upstash Box setup could not be confirmed",
            partial(ref, hasExpiry, !!token.restore),
          );
        } catch {
          return ctx.unknown(
            "Upstash Box setup could not be observed",
            partial(ref, hasExpiry, !!token.restore),
          );
        }
      }

      function prepareRestore(input: SnapshotRestoreInput) {
        assertResourceScope(input.snapshot, { provider: PROVIDER, scope });

        if (input.snapshot.kind !== "snapshot")
          throw new AdapterError("INVALID_ARGUMENT", "Upstash Box requires a snapshot reference");
        const resources = input.request.resources;

        if (resources?.diskMiB)
          throw new AdapterError(
            "UNSUPPORTED",
            "Upstash Box cannot select snapshot restore disk size",
          );

        const requested = smallestSize("Upstash Box", SIZES, {
          vcpus: Math.max(config.resources?.vcpus ?? 0, resources?.vcpu ?? 0),
          memoryMiB: Math.max(config.resources?.memoryMiB ?? 0, resources?.memoryMiB ?? 0),
        });

        return prepare(
          {
            image: { kind: "prepared", value: config.image },
            networkPolicy: input.request.networkPolicy,
            labels: input.request.labels,
            env: input.request.env,
            lifetimeSeconds: input.request.lifetimeSeconds,
            mounts: input.request.mounts,
          },
          Id.parse(input.snapshot.nativeId),
          requested.name,
        );
      }

      async function list(input: InventoryInput, ctx: ReadContext) {
        const cursor = input.cursor === undefined ? undefined : Id.safeParse(input.cursor);

        if (cursor && !cursor.success)
          throw new AdapterError("INVALID_ARGUMENT", "Invalid Upstash Box cursor");
        const rows = z.array(z.unknown()).safeParse(await transport.json("/v2/box", ctx.signal));

        if (!rows.success) throw new AdapterError("UNAVAILABLE", "Upstash Box list is invalid");

        const candidates = rows.data.flatMap((raw) => {
          const box = ListEntry.safeParse(raw);

          return box.success && (!cursor || box.data.id > cursor.data)
            ? [{ ...box.data, validDetail: Detail.safeParse(raw).success }]
            : [];
        });

        candidates.sort((left, right) => (left.id < right.id ? -1 : left.id === right.id ? 0 : 1));
        const page = candidates.slice(0, input.limit);

        return { page, nextCursor: candidates.length > page.length ? page.at(-1)?.id : undefined };
      }

      async function requireRunningGuest(box: Sandbox, signal: AbortSignal) {
        const { status } = await detail(locator(box), signal);

        if (status === "deleted") throw new AdapterError("NOT_FOUND", "Upstash Box was deleted");

        if (status === "paused")
          throw new AdapterError("CONFLICT", "Resume the Upstash Box before accessing its guest");

        if (status !== "idle" && status !== "running")
          throw new AdapterError(
            "UNAVAILABLE",
            "Upstash Box guest readiness could not be confirmed",
          );
      }

      const guardGuest = ephemeral ? undefined : requireRunningGuest;
      const files = boxFiles(transport, live.exec, locator, guardGuest);

      const restoreCapabilities: Support<RestoreCapabilities> = {
        status: "supported",
        value: {
          networkPolicies: policies,
          resources: true,
          mounts: false,
          independentLifecycle: true,
        },
      };

      const snapshots = snapshotHooks({
        transport,
        scope,
        boxKind: config.boxKind,
        restoreCapabilities,
        async readSandbox(box, ctx) {
          const native = await detail(locator(box), ctx.signal);

          if (
            box.reference
              ? !hasClassEvidence(native, box.reference, config.boxKind)
              : nativeKind(native) !== config.boxKind
          )
            throw new AdapterError("CONFLICT", "Could not confirm the Upstash Box kind");

          return { id: native.id, state: sandboxInfo(native, box.reference ?? null).state };
        },
      });

      const snapshotRestore: NonNullable<AdapterSession["snapshotRestore"]> = {
        recovery: { version: 1, token: CreateToken },
        options: { env: true, labels: true, lifetime: ephemeral ? LIFETIME : undefined },
        async prepare(input, ctx) {
          prepareRestore(input);

          const snapshot = await snapshots.snapshotInspect(input.snapshot, ctx);

          if (snapshot.state !== "ready")
            throw new AdapterError("CONFLICT", "Upstash Box snapshot is not ready");

          return input;
        },
        async submit(input, ctx) {
          return submitAllocation(prepareRestore(input), ctx);
        },
        async observe(attempt, ctx) {
          const token = CreateToken.safeParse(attempt.token);

          return observeAllocation(
            { ...attempt, sandbox: undefined, token: token.success ? token.data : undefined },
            ctx,
          );
        },
      };

      return {
        scope,
        defaultImage: { kind: "prepared", value: config.image },
        defaultNetworkPolicy: defaultPolicy,
        ...snapshots,
        snapshotRestore,
        processes: {
          ...processes.processes,
          async start(input, ctx) {
            locator(input.sandbox);

            if (guardGuest) await guardGuest(input.sandbox, ctx.signal);

            return processes.processes.start(input, ctx);
          },
        },
        ...(!ephemeral &&
          regularHooks({
            transport,
            identify: locator,
            keepAlive: config.keepAlive,
            access: config.preview?.access ?? "protected",
            async inspect(box, ctx) {
              const native = await detail(locator(box), ctx.signal);

              if (native.status === "deleted")
                throw new AdapterError("NOT_FOUND", "Upstash Box was deleted");

              if (
                box.reference
                  ? !hasClassEvidence(native, box.reference, "regular")
                  : nativeKind(native) !== "regular"
              )
                throw new AdapterError(
                  "CONFLICT",
                  "Could not confirm the saved Upstash Box is regular",
                );

              return {
                info: sandboxInfo(native, box.reference ?? null),
                keepAlive: native.keep_alive === true,
              };
            },
          })),
        supports: {
          images: ["prepared"],
          network: policies,
          lifetime: ephemeral ? LIFETIME : undefined,
          createEnv: true,
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input) {
            return prepare(input);
          },
          submit: submitAllocation,
          observe: observeAllocation,
        },
        async inventory(input, ctx) {
          const { page, nextCursor } = await list(input, ctx);

          return {
            items: page.map((box) => ({
              id: box.id,
              state:
                box.status === "deleted"
                  ? "destroyed"
                  : box.status === "running" || box.status === "idle"
                    ? "running"
                    : "unknown",
            })),
            nextCursor,
          };
        },
        async sandboxList(input, ctx) {
          const { page, nextCursor } = await list(input, ctx);

          return {
            coverage: "provider-scope",
            nextCursor,
            items: page.map((box) => ({
              id: box.id,
              state: sandboxState(box.status),
              reference:
                box.validDetail && box.status !== "deleted" && nativeKind(box) === config.boxKind
                  ? validateResourceReference({
                      version: 1,
                      kind: "sandbox",
                      provider: PROVIDER,
                      scope,
                      nativeId: box.id,
                      ownership: "borrowed",
                    })
                  : null,
              labels: box.labels
                ? listedLabels(
                    Object.fromEntries(
                      box.labels.flatMap((label) => {
                        const separator = label.indexOf(":");

                        return separator > 0
                          ? [[label.slice(0, separator), label.slice(separator + 1)]]
                          : [];
                      }),
                    ),
                    (key) => key === "bs",
                  )
                : null,
              createdAt: box.created_at === undefined ? null : listedTime(box.created_at * 1000),
            })),
          };
        },
        destroy: {
          recovery: { version: 1, token: DestroyToken },
          async prepare(box, ctx) {
            const id = locator(box);
            await detail(id, ctx.signal);

            return box;
          },
          async submit(box, ctx) {
            const id = locator(box);
            const token = { id, acknowledged: false };
            await ctx.checkpoint(token);

            try {
              await transport.empty(boxPath(id), ctx.signal, "DELETE");
            } catch (error) {
              if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

              return ctx.unknown("Upstash Box did not acknowledge deletion");
            }

            await ctx.checkpoint({ id, acknowledged: true });

            if (await deleted(id, true, ctx.signal))
              return { computeStopped: true, retainedResources: [] };

            return ctx.unknown(
              "Upstash Box acknowledged deletion but termination was not observed",
            );
          },
          async observe(attempt, ctx) {
            const token = DestroyToken.safeParse(attempt.token);

            if (!token.success || token.data.id !== attempt.sandbox?.id) return null;

            if (await deleted(token.data.id, token.data.acknowledged, ctx.signal))
              return { computeStopped: true, retainedResources: [] };

            return ctx.unknown(
              token.data.acknowledged
                ? "Upstash Box acknowledged deletion but termination was not observed"
                : "Upstash Box termination could not be confirmed",
            );
          },
        },
        async reopen(ref, ctx) {
          const id = locator({ id: ref.nativeId, reference: ref });
          const box = await detail(id, ctx.signal);

          if (box.status === "deleted")
            throw new AdapterError("NOT_FOUND", "Upstash Box was deleted");

          if (!hasClassEvidence(box, ref, config.boxKind))
            throw new AdapterError("CONFLICT", "Could not confirm the saved Upstash Box kind");

          return sandboxInfo(box, ref);
        },
        async inspect(box, ctx) {
          const id = locator(box);

          try {
            return { id, ...sandboxInfo(await detail(id, ctx.signal), box.reference ?? null) };
          } catch (error) {
            if (error instanceof BoxHttpError && error.status === 404) return null;
            throw error;
          }
        },
        exec: Object.assign(
          async (input: ExecInput, ctx: AttemptContext) => {
            locator(input.sandbox);

            try {
              if (guardGuest) await guardGuest(input.sandbox, ctx.signal);

              return await live.exec(input, ctx.signal);
            } catch (error) {
              if (error instanceof ExecLoss) return error.output;

              if (error instanceof AdapterError) return ctx.reject(error.code, error.message);
              throw error;
            }
          },
          { finiteStdin: "bytes" as const },
        ),
        files,
      } satisfies AdapterSession<
        Preparation,
        DestroyInput,
        ExecInput,
        import("@beachside/adapter").FileWriteInput,
        "argv" | "shell",
        CreateToken
      >;
    },
  });
}

export const upstashBoxAdapter = createUpstashBoxAdapter();
