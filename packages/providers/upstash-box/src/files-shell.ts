import {
  AdapterError,
  AdapterFilesystemError,
  type ExecInput,
  type ExecValue,
  type FileTransferContext,
  type Sandbox,
} from "@beachside/adapter";

export type GuestRunner = (input: ExecInput, signal: AbortSignal) => Promise<ExecValue>;

export const MAKE_STAGE = 'mkdir -m 700 -- "$1"';
export const REMOVE_STAGE = 'rm -rf -- "$1"';
export const APPEND_STAGE = 'cat -- "$1/chunk" >> "$1/data"';
export const COPY_STAGE = 'cp -P -- "$1" "$2/data" && [ ! -L "$2/data" ] && [ -f "$2/data" ]';

export const LINK_STAGE = `
if ln -T -- "$1/data" "$2"; then exit 0; fi
if [ -e "$2" ] || [ -L "$2" ]; then exit 73; fi
exit 74
`;

export const REMOVE_EMPTY_DIRECTORY = 'rmdir -- "$1"';

export async function guest(
  run: GuestRunner,
  sandbox: Sandbox,
  script: string,
  args: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();

  return (
    await run(
      {
        sandbox,
        command: { kind: "argv", argv: ["/bin/sh", "-c", script, "beachside", ...args] },
        deadlineSeconds: 30,
        maxOutputBytes: 1024,
      },
      signal,
    )
  ).exitCode;
}

/** Keep unpublished bytes in a single private directory beside the destination. */
export async function stagedFile(
  run: GuestRunner,
  input: { sandbox: Sandbox; destination: string; source?: string },
  ctx: FileTransferContext,
  fill: (stage: string) => Promise<void>,
  publish: (stage: string) => Promise<void>,
) {
  const parent = input.destination.slice(0, input.destination.lastIndexOf("/") + 1);
  const stage = `${parent}.beachside-${crypto.randomUUID()}`;

  ctx.signal.throwIfAborted();
  ctx.retain?.({ temporaryPaths: [stage] });
  let stageExit: number | null;

  try {
    stageExit = await guest(run, input.sandbox, MAKE_STAGE, [stage], ctx.signal);
  } catch (error) {
    // Explicit adapter errors occur before the guest command runs. A lost exec result leaves
    // the candidate path unverified, so never remove it based on that result.
    if (error instanceof AdapterError) {
      ctx.retain?.({ temporaryPaths: [] });
      throw error;
    }

    stageExit = null;
  }

  if (stageExit === null)
    throw new AdapterFilesystemError(
      "UNAVAILABLE",
      "Upstash Box did not acknowledge staging creation",
      {
        effect: "none",
        source: input.source,
        destination: input.destination,
        temporaryPaths: [stage],
      },
    );

  if (stageExit !== 0) {
    ctx.retain?.({ temporaryPaths: [] });
    throw new AdapterError("UNAVAILABLE", "Upstash Box could not create staging");
  }

  let publishing = false;
  let published = false;
  let failed = false;
  let failure: unknown;

  try {
    await fill(stage);
    ctx.signal.throwIfAborted();
    publishing = true;
    await publish(stage);
    published = true;
    ctx.retain?.({ effect: "applied" });
  } catch (error) {
    failure = error;
    failed = true;
  }

  // A publish with a lost completion can still be in flight. Keep its correlated
  // staging path instead of racing that mutation with cleanup.
  const uncertainPublish = failed && publishing && !(failure instanceof AdapterError);
  let removed = false;

  if (!uncertainPublish) {
    try {
      removed =
        (await guest(run, input.sandbox, REMOVE_STAGE, [stage], AbortSignal.timeout(5000))) === 0;
    } catch {
      // Report the staging path if cleanup could not be confirmed.
    }
  }

  if (removed) {
    ctx.retain?.({ temporaryPaths: [] });

    if (failed) throw failure;

    return;
  }

  const confirmedFailure = failure instanceof AdapterError ? failure : undefined;
  const code = confirmedFailure?.code ?? "UNAVAILABLE";

  const message = confirmedFailure
    ? confirmedFailure.message
    : published
      ? "Upstash Box published the file but did not confirm staging cleanup"
      : "Upstash Box could not confirm the filesystem operation";

  throw new AdapterFilesystemError(code, message, {
    effect: published ? "applied" : uncertainPublish ? "unknown" : "none",
    source: input.source,
    destination: input.destination,
    temporaryPaths: [stage],
  });
}
