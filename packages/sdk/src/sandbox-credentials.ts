import { z } from "zod";
import { CreateEnv } from "@beachside/adapter/portable";
import type { DestroyValue, SandboxReference } from "@beachside/adapter";
import type { AdapterDirectClient, AdapterSandbox } from "./adapter-direct";
import { BeachsideError, raceAbort, type RecoveryReference } from "./resource";
import { activeTraceParent } from "./observability";

/** A trusted-host source of short-lived environment credentials for SDK-started commands. */
export interface SandboxCredentials {
  acquire(
    signal: AbortSignal,
    traceParent?: string,
  ): Promise<{
    readonly env: Readonly<Record<string, string>>;
    readonly expiresAt: string;
    revoke(signal: AbortSignal, traceParent?: string): Promise<void>;
  }>;
}

type Grant = Awaited<ReturnType<SandboxCredentials["acquire"]>>;

type Revocation = Promise<BeachsideError | undefined>;

type InstalledGrant = {
  reference: SandboxReference | null;
  env?: Record<string, string>;
  expiresAt: number;
  revoke: Grant["revoke"];
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
]);

/** The original exception may come from an application callback or an HTTP transport. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Arbitrary thrown values are sanitized here.
function credentialFailure(error: unknown, message: string): BeachsideError {
  try {
    const code = brokerCode.safeParse(
      error instanceof Error && Object.getOwnPropertyDescriptor(error, "code")?.value,
    );

    if (code.success) return new BeachsideError(code.data, message);
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

  if (!installed.env || installed.expiresAt <= Date.now())
    throw new BeachsideError("UNAUTHENTICATED", "Sandbox credentials have expired or been revoked");

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
          expiresAt,
          revoke: (cleanupSignal, traceParent) => grant.revoke(cleanupSignal, traceParent),
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
