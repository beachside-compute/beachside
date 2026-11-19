import {
  AdapterCheckpointError,
  AdapterError,
  Preserve,
  PreviewResult,
  type AdapterSession,
  type ReadContext,
  type Sandbox,
  type SandboxInfo,
  type SandboxReference,
  type ObserveContext,
  type RecoveryAttempt,
} from "@beachside/adapter";
import { z } from "zod";
import { boxPath } from "./files";
import { definitiveRefusal, type Transport } from "./transport";

const Preview = z.object({
  url: z.url(),
  port: z.number().int(),
  token: z.string().min(1).optional(),
});

const PreviewList = z.object({
  previews: z.array(Preview.extend({ bearer_token: z.boolean(), basic_auth: z.boolean() })),
});

type RegularHooks = Pick<
  AdapterSession,
  "preview" | "suspend" | "resume" | "suspensionCapabilities" | "resumeCapabilities"
>;

export function regularHooks(options: {
  transport: Transport;
  identify: (box: Sandbox) => string;
  inspect: (box: Sandbox, ctx: ReadContext) => Promise<{ info: SandboxInfo; keepAlive: boolean }>;
  keepAlive: boolean;
  access: "public" | "protected";
}): RegularHooks {
  const { transport, identify, inspect, keepAlive, access } = options;

  const preview: NonNullable<RegularHooks["preview"]> = async ({ sandbox, port }, ctx) => {
    const id = identify(sandbox);
    const { info: box } = await inspect(sandbox, ctx);

    if (box.state !== "running")
      throw new AdapterError("CONFLICT", "Resume the Upstash Box before publishing a preview");

    const path = `${boxPath(id)}/preview`;
    const host = `${id.toLowerCase()}-${port}.preview.box.upstash.com`;
    const current = PreviewList.safeParse(await transport.json(path, ctx.signal));

    if (!current.success)
      throw new AdapterError("UNAVAILABLE", "Upstash Box preview list is invalid");
    const existing = current.data.previews.find((entry) => entry.port === port);

    if (existing) {
      if (existing.basic_auth || existing.bearer_token !== (access === "protected"))
        throw new AdapterError(
          "CONFLICT",
          "Upstash Box port already has a different preview access mode",
        );

      if (new URL(existing.url).hostname !== host)
        throw new AdapterError("UNAVAILABLE", "Upstash Box returned a mismatched preview");

      if (access === "public") return PreviewResult.parse({ access, url: existing.url });
    }

    const parsed = Preview.safeParse(
      await transport.json(path, ctx.signal, "POST", {
        port,
        bearer_token: access === "protected",
        basic_auth: false,
      }),
    );

    if (!parsed.success || parsed.data.port !== port || new URL(parsed.data.url).hostname !== host)
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned a mismatched preview");

    const { url, token } = parsed.data;

    const result = PreviewResult.safeParse(
      access === "protected"
        ? { access, url, headers: token ? { Authorization: `Bearer ${token}` } : {} }
        : token
          ? undefined
          : { access, url },
    );

    if (!result.success)
      throw new AdapterError(
        "UNAVAILABLE",
        "Upstash Box did not confirm the configured preview access",
      );

    return result.data;
  };

  if (keepAlive) return { preview };
  const LifecycleAck = z.strictObject({ id: z.string().min(1).max(128) });
  const recovery = { version: 1, token: LifecycleAck };

  const suspendFacts = {
    preserve: Preserve.FILESYSTEM,
    processes: "terminated",
    connections: "dropped",
  } as const;

  const resumeFacts = { execution: "fresh", connections: "dropped" } as const;

  function pausePartial(reference: SandboxReference) {
    return {
      kind: "sandbox_suspend",
      status: "partial",
      reference,
      acknowledged: true,
      ...suspendFacts,
      observation: null,
    } as const;
  }

  function resumePartial(reference: SandboxReference) {
    return {
      kind: "sandbox_resume",
      status: "partial",
      reference,
      acknowledged: true,
      ...resumeFacts,
      observation: null,
    } as const;
  }

  async function observed(attempt: RecoveryAttempt, ctx: ReadContext) {
    const token = LifecycleAck.safeParse(attempt.token);
    const box = attempt.sandbox;

    if (!token.success || !box?.reference || token.data.id !== box.id) return null;
    const { info } = await inspect(box, ctx).catch(() => ({ info: null }));

    return { token: token.data, reference: box.reference, info };
  }

  async function canChangeState(box: Sandbox | undefined, ctx: ReadContext) {
    if (!box) return null;

    const current = await inspect(box, ctx).catch(() => null);

    if (!current)
      return { status: "unknown", reason: "Upstash Box state could not be verified" } as const;

    if (current.keepAlive)
      return {
        status: "unsupported",
        reason: "Upstash keep-alive boxes cannot pause or resume",
      } as const;

    return null;
  }

  async function assertTransition(box: Sandbox, desired: "running" | "stopped", ctx: ReadContext) {
    const { info, keepAlive: active } = await inspect(box, ctx);

    if (active)
      throw new AdapterError("UNSUPPORTED", "Upstash keep-alive boxes cannot pause or resume");

    if (info.state !== desired)
      throw new AdapterError("CONFLICT", `Upstash Box must be ${desired} for this operation`);
  }

  const suspend: NonNullable<RegularHooks["suspend"]> = {
    recovery,
    async prepare(input, ctx) {
      await assertTransition(input.sandbox, "running", ctx);

      return { ...input, intent: { action: "suspend", preserve: Preserve.FILESYSTEM } };
    },
    async submit(input, ctx) {
      const id = identify(input.sandbox);

      try {
        await assertTransition(input.sandbox, "running", {
          signal: ctx.signal,
          deadline: Date.now() + 30_000,
        });
      } catch (error) {
        if (error instanceof AdapterError) return ctx.reject(error.code, error.message);

        return ctx.reject("UNAVAILABLE", "Upstash Box state could not be verified before dispatch");
      }

      try {
        await transport.empty(`${boxPath(id)}/pause`, ctx.signal, "POST");
      } catch (error) {
        if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

        return ctx.unknown("Upstash Box pause was not acknowledged");
      }

      const token = { id };

      try {
        await ctx.checkpoint(token);
      } catch (error) {
        if (error instanceof AdapterCheckpointError)
          error.outcome = pausePartial(input.sandbox.reference);
        throw error;
      }

      return observePause(
        { ...ctx, sandbox: input.sandbox, token },
        {
          signal: ctx.signal,
          deadline: Date.now() + 30_000,
          pending: ctx.pending,
          unknown: ctx.unknown,
        },
      );
    },
    observe: observePause,
  };

  async function observePause(attempt: RecoveryAttempt, ctx: ObserveContext) {
    const current = await observed(attempt, ctx);

    if (!current) return ctx.unknown("Upstash Box pause acknowledgement is unavailable");
    const { token, reference, info } = current;

    if (info?.state === "stopped") return { reference, ...suspendFacts, observation: info };

    if (info?.state === "running") return ctx.pending(token, { pollAfterMs: 1_000 });

    return ctx.unknown(
      "Upstash Box acknowledged pause but stopped state was not observed",
      pausePartial(reference),
    );
  }

  const resume: NonNullable<RegularHooks["resume"]> = {
    recovery,
    async prepare(input, ctx) {
      await assertTransition(input.sandbox, "stopped", ctx);

      return { ...input, intent: { action: "resume" } };
    },
    async submit(input, ctx) {
      const id = identify(input.sandbox);

      try {
        await assertTransition(input.sandbox, "stopped", {
          signal: ctx.signal,
          deadline: Date.now() + 30_000,
        });
      } catch (error) {
        if (error instanceof AdapterError) return ctx.reject(error.code, error.message);

        return ctx.reject("UNAVAILABLE", "Upstash Box state could not be verified before dispatch");
      }

      try {
        await transport.empty(`${boxPath(id)}/resume`, ctx.signal, "POST");
      } catch (error) {
        if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

        return ctx.unknown("Upstash Box resume was not acknowledged");
      }

      const token = { id };

      try {
        await ctx.checkpoint(token);
      } catch (error) {
        if (error instanceof AdapterCheckpointError)
          error.outcome = resumePartial(input.sandbox.reference);
        throw error;
      }

      return observeResume(
        { ...ctx, sandbox: input.sandbox, token },
        {
          signal: ctx.signal,
          deadline: Date.now() + 30_000,
          pending: ctx.pending,
          unknown: ctx.unknown,
        },
      );
    },
    observe: observeResume,
  };

  async function observeResume(attempt: RecoveryAttempt, ctx: ObserveContext) {
    const current = await observed(attempt, ctx);

    if (!current) return ctx.unknown("Upstash Box resume acknowledgement is unavailable");
    const { token, reference, info } = current;

    if (info?.state === "running")
      return { reference, ...resumeFacts, executionIdentity: info.execution, observation: info };

    if (info?.state === "stopped") return ctx.pending(token, { pollAfterMs: 1_000 });

    return ctx.unknown(
      "Upstash Box acknowledged resume but running state was not observed",
      resumePartial(reference),
    );
  }

  return {
    preview,
    suspend,
    resume,
    async suspensionCapabilities({ sandbox }, ctx) {
      return (await canChangeState(sandbox, ctx)) ?? { status: "supported", value: suspendFacts };
    },
    async resumeCapabilities({ sandbox }, ctx) {
      return (
        (await canChangeState(sandbox, ctx)) ?? {
          status: "supported",
          value: { sourceStates: ["stopped"], setsSessionTimeout: false },
        }
      );
    },
  };
}
