import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AdapterCheckpointError,
  AdapterError,
  AllowNetworkSetting,
  DEFAULT_LIFETIME_SECONDS,
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
  type FileWriteInput,
  type OperationOutcome,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type Scope,
} from "@beachside/adapter";
import { createExec, ExecLoss, MAX_OUTPUT_BYTES } from "./exec";
import { boxFiles, boxPath, EXCLUSIVE_WRITE, MAX_FILE_BYTES } from "./files";
import { BoxHttpError, createTransport, definitiveRefusal, ORIGIN } from "./transport";

const PROVIDER = "upstash-box";
const REGION = "us-east-1";
const IMAGE = "node";
const LIFETIME = { minSeconds: 300, maxSeconds: 259_200 };

const SIZES = [
  { name: "small", vcpus: 2, memoryMiB: 4096 },
  { name: "medium", vcpus: 4, memoryMiB: 8192 },
  { name: "large", vcpus: 8, memoryMiB: 16384 },
] as const;

const Size = z.enum(["small", "medium", "large"]);

const Setup = z.strictObject({
  image: z.literal(IMAGE).default(IMAGE),
  network: z.union([z.enum(["internet", "blocked"]), AllowNetworkSetting]).default("internet"),
  resources: ResourceMinimums.optional(),
  lifecycle: z
    .strictObject({
      lifetimeSeconds: z
        .number()
        .int()
        .min(LIFETIME.minSeconds)
        .max(LIFETIME.maxSeconds)
        .default(DEFAULT_LIFETIME_SECONDS),
    })
    .default({ lifetimeSeconds: DEFAULT_LIFETIME_SECONDS }),
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
  status: z.enum(["creating", "idle", "running", "paused", "error", "deleted"]),
  runtime: z.string().optional(),
  size: Size.optional(),
  labels: z.array(NativeLabel).max(5).optional(),
  expires_at: z.number().int().positive().max(8_640_000_000_000).optional().catch(undefined),
  network_policy: Policy.optional(),
});

type Detail = z.infer<typeof Detail>;

const Preparation = z.strictObject({
  size: Size,
  ttl: z.number().int().min(LIFETIME.minSeconds).max(LIFETIME.maxSeconds),
  network_policy: Policy,
  labels: z.array(NativeLabel).max(4),
});

type Preparation = z.infer<typeof Preparation>;

const CreateToken = z.strictObject({
  id: Id,
  size: Size,
  labels: z.array(NativeLabel).max(4),
  policy: z.string().regex(/^[a-f0-9]{64}$/),
  earliestExpiry: z.number().int().safe(),
  latestExpiry: z.number().int().safe(),
});

type CreateToken = z.infer<typeof CreateToken>;

const DestroyToken = z.strictObject({ id: Id, acknowledged: z.boolean() });

export type UpstashBoxAdapterOptions = {
  /** Native transport overrides for host-owned tests. */
  fetch?: typeof fetch;
};

function marker(submissionId: string) {
  return (
    CorrelationPrefix + createHash("sha256").update(submissionId).digest("base64url").slice(0, 17)
  );
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

function hasRequestedExpiry(detail: Detail, token: CreateToken) {
  const expires = detail.expires_at;

  return expires !== undefined && expires >= token.earliestExpiry && expires <= token.latestExpiry;
}

function ready(detail: Detail, token: CreateToken, submissionId: string) {
  return (
    detail.ephemeral === true &&
    (detail.status === "idle" || detail.status === "running") &&
    detail.runtime === IMAGE &&
    detail.size === token.size &&
    hasRequestedExpiry(detail, token) &&
    (detail.expires_at ?? 0) * 1000 > Date.now() &&
    detail.labels?.includes(marker(submissionId)) &&
    token.labels.every((label) => detail.labels?.includes(label)) &&
    token.policy === policyDigest(detail.network_policy)
  );
}

function sandboxInfo(detail: Detail, reference: SandboxReference | null): SandboxInfo {
  const size = SIZES.find((entry) => entry.name === detail.size);

  const state = {
    idle: "running",
    running: "running",
    paused: "stopped",
    deleted: "destroyed",
    creating: "unknown",
    error: "unknown",
  } as const;

  return {
    ...unknownSandboxFacts(),
    reference,
    state: state[detail.status],
    nativeState: detail.status,
    observedAt: new Date().toISOString(),
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
        image: { env: "UPSTASH_BOX_IMAGE", choices: [IMAGE] },
        network: { env: "UPSTASH_BOX_NETWORK", choices: ["internet", "blocked"] },
      },
      docs: "https://beachside.run/docs/providers/upstash-box/",
    },
    async connect({ config, credentials, host }) {
      const size = smallestSize("Upstash Box", SIZES, config.resources ?? {});
      const parsedAllow = allowlistConfig("Upstash Box", config.network);
      throwAllowlistError(parsedAllow);
      const allowlist = parsedAllow.allowlist && allowlistFromCanonical(parsedAllow.allowlist);

      if (allowlist) rejectPrivateRanges(allowlist.cidrs);

      const defaultPolicy = networkPolicyName(config.network);
      const policies = allowlist ? ["allow"] : ["internet", "blocked"];

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
      const list = await transport.json("/v2/box", host.signal);

      if (!Array.isArray(list))
        throw new AdapterError("UNAVAILABLE", "Upstash Box list is invalid");

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

      function partial(ref: SandboxReference, acknowledged: boolean): OperationOutcome {
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

      const files = boxFiles(transport);

      return {
        scope,
        defaultImage: { kind: "prepared", value: config.image },
        defaultNetworkPolicy: defaultPolicy,
        supports: {
          images: ["prepared"],
          network: policies,
          lifetime: LIFETIME,
          exec: { commands: ["argv", "shell"], maxOutputBytes: MAX_OUTPUT_BYTES },
          fileWrite: { overwrite: true, noClobber: true },
        },
        create: {
          recovery: { version: 1, token: CreateToken },
          async prepare(input) {
            if (
              input.image.kind !== "prepared" ||
              input.image.value !== IMAGE ||
              (input.region !== undefined && input.region !== REGION) ||
              input.requirements ||
              input.mounts?.length ||
              Object.keys(input.env ?? {}).length
            )
              throw new AdapterError(
                "UNSUPPORTED",
                "Upstash Box requires the node image in us-east-1 without mounts, state requirements or create env",
              );
            const ttl = input.lifetimeSeconds ?? config.lifecycle.lifetimeSeconds;
            let network_policy: Policy;

            switch (input.networkPolicy) {
              case "internet":
                network_policy = { mode: "allow-all" };
                break;
              case "blocked":
                network_policy = { mode: "deny-all" };
                break;
              case "allow":
                if (!allowlist)
                  throw new AdapterError(
                    "UNSUPPORTED",
                    "Configure the Upstash Box allowlist first",
                  );
                network_policy = {
                  mode: "custom",
                  allowed_domains: [...allowlist.hosts],
                  allowed_cidrs: [...allowlist.cidrs],
                };
                break;
              default:
                throw new AdapterError("UNSUPPORTED", "Unsupported Upstash Box network policy");
            }

            if (!policies.includes(input.networkPolicy))
              throw new AdapterError(
                "UNSUPPORTED",
                "Upstash Box requires the configured allowlist",
              );

            return { size: size.name, ttl, network_policy, labels: nativeLabels(input.labels) };
          },
          async submit(prepared, ctx) {
            let raw: unknown;
            const sentAt = Math.floor(Date.now() / 1000);

            try {
              raw = await transport.json("/v2/box", ctx.signal, "POST", {
                ...prepared,
                ephemeral: true,
                runtime: IMAGE,
                labels: [...prepared.labels, marker(ctx.submissionId)],
              });
            } catch (error) {
              if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

              return ctx.unknown("Upstash Box did not confirm allocation");
            }

            const parsed = z.object({ id: Id }).safeParse(raw);

            if (!parsed.success) return ctx.unknown("Upstash Box returned no usable allocation ID");
            const { id } = parsed.data;
            const ref = reference(id, ctx);

            // The service reports expiration in whole seconds. Allow for clock skew and requests
            // that spent time in flight, but reject a fallback to the provider's three-day TTL.
            const token = {
              id,
              size: prepared.size,
              labels: prepared.labels,
              policy: policyDigest(prepared.network_policy),
              earliestExpiry: sentAt + prepared.ttl - 5,
              latestExpiry: Math.ceil(Date.now() / 1000) + prepared.ttl + 5,
            };

            const native = Detail.safeParse(raw);
            const hasExpiry = native.success && hasRequestedExpiry(native.data, token);

            try {
              await ctx.checkpoint(token);
            } catch (error) {
              if (error instanceof AdapterCheckpointError) error.outcome = partial(ref, hasExpiry);
              throw error;
            }

            try {
              if (native.success && ready(native.data, token, ctx.submissionId))
                return { id, reference: ref, state: "running" };
            } catch {
              // A malformed policy cannot confirm the requested guarantee.
            }

            try {
              const current = await detail(id, ctx.signal);

              if (ready(current, token, ctx.submissionId))
                return { id, reference: ref, state: "running" };
            } catch {
              // The create response still establishes the known ID.
            }

            return ctx.unknown(
              "Upstash Box allocation is known but setup was not confirmed",
              partial(ref, hasExpiry),
            );
          },
          async observe(attempt, ctx) {
            if (!attempt.token) return null;
            const { id } = attempt.token;
            const ref = reference(id, attempt);

            try {
              const box = await detail(id, ctx.signal);

              if (ready(box, attempt.token, attempt.submissionId))
                return { id, reference: ref, state: "running" };

              return ctx.unknown(
                "Upstash Box setup could not be confirmed",
                partial(ref, hasRequestedExpiry(box, attempt.token)),
              );
            } catch {
              return ctx.unknown("Upstash Box setup could not be observed", partial(ref, false));
            }
          },
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

            if (await deleted(token.data.id, false, ctx.signal))
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

          if (box.ephemeral === false)
            throw new AdapterError("CONFLICT", "Saved Upstash Box is not ephemeral");

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
              return await live.exec(input, ctx.signal);
            } catch (error) {
              if (error instanceof ExecLoss) return error.output;

              if (error instanceof AdapterError) return ctx.reject(error.code, error.message);
              throw error;
            }
          },
          { finiteStdin: "bytes" as const },
        ),
        files: {
          ...files,
          read(input, ctx) {
            locator(input.sandbox);

            return files.read(input, ctx);
          },
          readStream(input, ctx) {
            locator(input.sandbox);

            return files.readStream(input, ctx);
          },
          async write(input: FileWriteInput, ctx) {
            const id = locator(input.sandbox);

            if (input.bytes.byteLength > MAX_FILE_BYTES)
              return ctx.reject("CAPACITY", "Upstash Box write exceeds the 1 MiB adapter limit");

            try {
              if (input.overwrite) {
                await transport.empty(`${boxPath(id)}/files/write`, ctx.signal, "POST", {
                  path: input.path,
                  encoding: "base64",
                  content: Buffer.from(input.bytes).toString("base64"),
                });
              } else {
                const result = await live.exec(
                  {
                    sandbox: input.sandbox,
                    command: {
                      kind: "argv",
                      argv: [
                        "node",
                        "-e",
                        EXCLUSIVE_WRITE,
                        "--",
                        input.path,
                        String(input.bytes.byteLength),
                      ],
                    },
                    stdin: input.bytes,
                    deadlineSeconds: 30,
                    maxOutputBytes: 0,
                  },
                  ctx.signal,
                );

                if (result.exitCode === 73)
                  return ctx.reject("CONFLICT", "Upstash Box file already exists");

                if (result.exitCode !== 0)
                  return ctx.unknown("Upstash Box could not confirm the exclusive write");
              }

              return { bytesWritten: input.bytes.byteLength };
            } catch (error) {
              if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

              return ctx.unknown("Upstash Box could not confirm the write");
            }
          },
        },
      } satisfies AdapterSession<
        Preparation,
        DestroyInput,
        ExecInput,
        FileWriteInput,
        "argv" | "shell",
        CreateToken
      >;
    },
  });
}

export const upstashBoxAdapter = createUpstashBoxAdapter();
