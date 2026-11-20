import { z } from "zod";
import { CreateEnv } from "@beachside/adapter/portable";
import type { DestroyValue, SandboxReference } from "@beachside/adapter";
import type { AdapterDirectClient, AdapterSandbox } from "./adapter-direct";
import {
  BeachsideError,
  raceAbort,
  UnsupportedFeatureError,
  type RecoveryReference,
} from "./resource";
import { activeTraceParent } from "./observability";

/**
 * A trusted-host source of a short-lived grant for SDK-started commands, such as
 * `broker.sandbox()` from `@beachside/credential-client`.
 */
export interface SandboxCredentials {
  acquire(
    signal: AbortSignal,
    traceParent?: string,
  ): Promise<{
    /** The grant's identity at its source, when it has one. */
    readonly id?: string;
    /** The integrations the grant covers, when the source reports them. */
    readonly integrations?: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly expiresAt: string;
    revoke(signal: AbortSignal, traceParent?: string): Promise<void>;
    /** Move expiry to `ttlSeconds` from now and return the new expiry. Sources without renewal omit it. */
    renew?(ttlSeconds: number, signal: AbortSignal, traceParent?: string): Promise<string>;
  }>;
}

/** What a sandbox handle knows about its grant. Never includes the token. */
export type SandboxGrantStatus =
  | { readonly status: "none" }
  | {
      readonly status: "active" | "expired" | "revoked";
      readonly id?: string;
      readonly integrations?: readonly string[];
      /** The environment variable names the grant sets on every SDK-started command. */
      readonly env: readonly string[];
      readonly expiresAt: string;
      readonly renewable: boolean;
    };

type Grant = Awaited<ReturnType<SandboxCredentials["acquire"]>>;

type Revocation = Promise<BeachsideError | undefined>;

type InstalledGrant = {
  reference: SandboxReference | null;
  env?: Record<string, string>;
  names: string[];
  id?: string;
  integrations?: string[];
  expiresAt: number;
  revoke: Grant["revoke"];
  renew?: NonNullable<Grant["renew"]>;
  revocation?: Revocation;
  retryRevocation?: boolean;
};

const byHandle = new WeakMap<AdapterSandbox, InstalledGrant>();

const byClient = new WeakMap<AdapterDirectClient, Map<string, InstalledGrant>>();

const brokerBudget = 15_000;

const brokerCode = z.enum([
  "INVALID_ARGUMENT",
  "INVALID_RESPONSE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "RATE_LIMIT",
  "TIMEOUT",
  "WAIT_ABORTED",
  "UNAVAILABLE",
  "NOT_FOUND",
]);

const refusal = z.enum(["not_found", "disabled", "not_allowlisted", "not_in_policy"]);

const integrationIds = z
  .array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/))
  .min(1)
  .max(16);

/** A safe, actionable message for a refused grant: only validated enum and ID values cross. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Arbitrary thrown values are sanitized here.
function refusalMessage(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return;
    const reason = refusal.safeParse(Object.getOwnPropertyDescriptor(error, "reason")?.value);

    const ids = integrationIds.safeParse(
      Object.getOwnPropertyDescriptor(error, "integrations")?.value,
    );

    if (!reason.success || !ids.success) return;
    const names = ids.data.join(", ");

    switch (reason.data) {
      case "not_found":
        return `The credential broker has no integration named ${names}`;
      case "disabled":
        return `Integration ${names} is disabled on the credential broker`;
      case "not_allowlisted":
        return `Integration ${names} is not allowed to issue grants. Run \`beachside broker issuer allow ${ids.data.join(" ")}\``;
      case "not_in_policy":
        return `The GitHub Actions broker policy does not include ${names}`;
    }
  } catch {
    // A thrown proxy can also fail inspection.
  }
}

/** The original exception may come from an application callback or an HTTP transport. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Arbitrary thrown values are sanitized here.
function credentialFailure(error: unknown, message: string): BeachsideError {
  try {
    const code = brokerCode.safeParse(
      error instanceof Error && Object.getOwnPropertyDescriptor(error, "code")?.value,
    );

    if (code.success) return new BeachsideError(code.data, refusalMessage(error) ?? message);
  } catch {
    // A thrown proxy can also fail inspection.
  }

  return new BeachsideError("UNAVAILABLE", message);
}

function knownGrant(client: AdapterDirectClient, id: string, reference: SandboxReference | null) {
  if (!reference) return;
  const installed = byClient.get(client)?.get(id);

  if (!installed?.reference) return;

  if (
    installed.reference.generation === reference.generation &&
    installed.reference.receipt === reference.receipt
  )
    return installed;
}

function installedGrant(client: AdapterDirectClient, box: AdapterSandbox) {
  return byHandle.get(box) ?? knownGrant(client, box.id, box.reference);
}

export function hasSandboxCredentials(client: AdapterDirectClient, box: AdapterSandbox): boolean {
  return !!installedGrant(client, box);
}

export function commandEnvironment(
  client: AdapterDirectClient,
  box: AdapterSandbox,
  env?: Record<string, string>,
): Record<string, string> | undefined {
  const installed = installedGrant(client, box);

  if (!installed) return env;

  if (!installed.env)
    throw new BeachsideError(
      "UNAUTHENTICATED",
      "This sandbox's grant was revoked when it was destroyed or its setup failed",
    );

  if (installed.expiresAt <= Date.now())
    throw new BeachsideError(
      "UNAUTHENTICATED",
      "This sandbox's grant has expired. Renew it before expiry with `box.renewGrant()`, or create a new sandbox",
    );

  if (
    env &&
    Object.entries(installed.env).some(
      ([key, value]) => Object.hasOwn(env, key) && env[key] !== value,
    )
  )
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "Command environment conflicts with sandbox credentials",
    );

  return { ...env, ...installed.env };
}

export async function acquireSandboxCredentials(
  client: AdapterDirectClient,
  box: AdapterSandbox,
  credentials: SandboxCredentials,
  workSignal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(brokerBudget);
  const signal = AbortSignal.any([client.signal, timeout, ...(workSignal ? [workSignal] : [])]);

  await client.telemetry.run(
    "beachside.credentials.acquire",
    async () => {
      const acquire = async () => {
        signal.throwIfAborted();

        const grant = await credentials.acquire(
          signal,
          client.telemetry.enabled ? activeTraceParent() : undefined,
        );

        const expiry = z.iso.datetime({ offset: true }).safeParse(grant?.expiresAt);
        const env = CreateEnv.safeParse(grant?.env);
        const revocable = z.function().safeParse(grant?.revoke);
        const renewable = z.function().safeParse(grant?.renew);
        const id = z.string().min(1).max(128).safeParse(grant?.id);
        const integrations = integrationIds.safeParse(grant?.integrations);
        const expiresAt = expiry.success ? Date.parse(expiry.data) : NaN;

        if (
          signal.aborted ||
          !env.success ||
          Object.values(env.data).some((value) => value.length > 8192) ||
          !revocable.success ||
          !(expiresAt > Date.now())
        ) {
          if (revocable.success)
            await raceAbort(
              Promise.resolve().then(() => grant.revoke(AbortSignal.timeout(brokerBudget))),
              AbortSignal.timeout(brokerBudget),
            ).catch(() => undefined);
          throw new BeachsideError(
            "INVALID_RESPONSE",
            "Credential source returned an invalid grant",
          );
        }

        const installed: InstalledGrant = {
          reference: box.reference,
          env: env.data,
          names: Object.keys(env.data).sort(),
          ...(id.success && { id: id.data }),
          ...(integrations.success && { integrations: integrations.data }),
          expiresAt,
          revoke: (cleanupSignal, traceParent) => grant.revoke(cleanupSignal, traceParent),
          ...(renewable.success && {
            renew: (ttl: number, renewSignal: AbortSignal, traceParent?: string) =>
              grant.renew!(ttl, renewSignal, traceParent),
          }),
        };

        byHandle.set(box, installed);

        if (box.reference) {
          let sandboxes = byClient.get(client);

          if (!sandboxes) {
            sandboxes = new Map();
            byClient.set(client, sandboxes);
          }

          sandboxes.set(box.id, installed);
        }
      };

      try {
        await raceAbort(acquire(), signal);
      } catch (error) {
        if (workSignal?.aborted || client.signal.aborted)
          throw new BeachsideError("WAIT_ABORTED", "Sandbox credential acquisition was cancelled");

        if (timeout.aborted)
          throw new BeachsideError("TIMEOUT", "Sandbox credential acquisition timed out");

        // Runtime errors are arbitrary JavaScript values. Only the safe public code may cross.
        throw credentialFailure(error, "Sandbox credential acquisition failed");
      }
    },
    { signal },
  );
}

/** The grant this handle carries, without its token. */
export function sandboxGrantStatus(
  client: AdapterDirectClient,
  box: AdapterSandbox,
): SandboxGrantStatus {
  const installed = installedGrant(client, box);

  if (!installed) return { status: "none" };

  return {
    status: !installed.env ? "revoked" : installed.expiresAt <= Date.now() ? "expired" : "active",
    ...(installed.id && { id: installed.id }),
    ...(installed.integrations && { integrations: [...installed.integrations] }),
    env: [...installed.names],
    expiresAt: new Date(installed.expiresAt).toISOString(),
    renewable: Boolean(installed.renew),
  };
}

/** Extend an active grant at its source. Commands keep the same token, so nothing restarts. */
export async function renewSandboxGrant(
  client: AdapterDirectClient,
  box: AdapterSandbox,
  ttlSeconds: number,
  workSignal?: AbortSignal,
): Promise<SandboxGrantStatus> {
  const installed = installedGrant(client, box);

  if (!installed)
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "This sandbox handle has no grant. Grants attach when sandboxes.create() or with() requests one",
    );

  if (!installed.env || installed.expiresAt <= Date.now())
    throw new BeachsideError("UNAUTHENTICATED", "Only an active grant can be renewed");

  if (!installed.renew)
    throw new UnsupportedFeatureError("grant renewal", [
      "This credential source cannot renew grants",
    ]);

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
    throw new BeachsideError("INVALID_ARGUMENT", "ttlSeconds must be a positive whole number");

  const timeout = AbortSignal.timeout(brokerBudget);
  const signal = AbortSignal.any([client.signal, timeout, ...(workSignal ? [workSignal] : [])]);
  const renew = installed.renew;

  await client.telemetry.run(
    "beachside.credentials.renew",
    async () => {
      try {
        const expiresAt = await raceAbort(
          Promise.resolve().then(() =>
            renew(ttlSeconds, signal, client.telemetry.enabled ? activeTraceParent() : undefined),
          ),
          signal,
        );

        const parsed = z.iso.datetime({ offset: true }).safeParse(expiresAt);

        if (!parsed.success || !(Date.parse(parsed.data) > Date.now()))
          throw new BeachsideError(
            "INVALID_RESPONSE",
            "Credential source returned an invalid expiry",
          );

        installed.expiresAt = Date.parse(parsed.data);
      } catch (error) {
        if (error instanceof BeachsideError && error.code === "INVALID_RESPONSE") throw error;

        if (workSignal?.aborted || client.signal.aborted)
          throw new BeachsideError("WAIT_ABORTED", "Sandbox grant renewal was cancelled");

        if (timeout.aborted) throw new BeachsideError("TIMEOUT", "Sandbox grant renewal timed out");

        throw credentialFailure(error, "Sandbox grant renewal failed");
      }
    },
    { signal },
  );

  return sandboxGrantStatus(client, box);
}

/** Start an independently bounded attempt and configure concurrent callers to share it. */
export function revokeSandboxCredentials(
  client: AdapterDirectClient,
  box: AdapterSandbox,
): Revocation | undefined {
  const installed = installedGrant(client, box);

  if (!installed) return;

  installed.env = undefined;

  if (!installed.revocation || installed.retryRevocation) {
    installed.retryRevocation = false;
    const signal = AbortSignal.timeout(brokerBudget);
    installed.revocation = client.telemetry
      .run("beachside.credentials.revoke", async () => {
        try {
          if (installed.expiresAt > Date.now())
            await raceAbort(
              Promise.resolve().then(() =>
                installed.revoke(
                  signal,
                  client.telemetry.enabled ? activeTraceParent() : undefined,
                ),
              ),
              signal,
            );
        } catch (error) {
          if (signal.aborted)
            throw new BeachsideError("TIMEOUT", "Sandbox credential revocation timed out");
          throw credentialFailure(error, "Sandbox credential revocation failed");
        }
      })
      .then(
        () => {
          installed.revoke = async () => {};

          return undefined;
        },
        (error: BeachsideError) => {
          // Allow a new explicit destruction attempt to retry a failed revocation.
          installed.retryRevocation = true;

          return error;
        },
      );
  }

  return installed.revocation;
}

/** Revoke on submission, then report meaningful failure while preserving native evidence. */
export class SandboxCredentialRevocationError extends BeachsideError {
  constructor(
    readonly revocationError: BeachsideError,
    readonly sandboxId: string,
    readonly sandboxReference: SandboxReference | null,
    readonly destroyOutcome?: DestroyValue,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve an arbitrary original destruction failure.
    readonly destroyError?: unknown,
    operation?: RecoveryReference,
  ) {
    const failure = destroyError instanceof BeachsideError ? destroyError : undefined;
    super(
      "CREDENTIAL_REVOCATION_FAILED",
      "Sandbox credential revocation was not confirmed",
      destroyOutcome ? "applied" : (failure?.effect ?? "possible"),
      failure?.outcome,
      failure?.reference ?? operation,
    );
    this.name = "SandboxCredentialRevocationError";
  }
}

export function releaseCredentialState(
  client: AdapterDirectClient,
  id: string,
  reference: SandboxReference | null,
  revocation: Revocation,
) {
  if (knownGrant(client, id, reference)?.revocation === revocation)
    byClient.get(client)?.delete(id);
}

export function destroyRevocation(
  client: AdapterDirectClient,
  id: string,
  reference: SandboxReference | null,
): Revocation | undefined {
  return knownGrant(client, id, reference)?.revocation;
}
