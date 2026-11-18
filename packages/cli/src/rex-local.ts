import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Output } from "./output";

export type RexRun = (binary: string, args: string[]) => Promise<string>;

function runner(env: NodeJS.ProcessEnv, signal: AbortSignal): RexRun {
  return (binary, args) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        args,
        { env, signal, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
}

/** Prefer an explicit executable, then PATH, then the macOS app's bundled CLI. */
export async function findRex(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.BEACHSIDE_REX_BIN) return env.BEACHSIDE_REX_BIN;

  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, process.platform === "win32" ? "rex.exe" : "rex"));

  if (process.platform === "darwin") {
    for (const directory of ["/Applications", join(env.HOME ?? homedir(), "Applications")]) {
      for (const app of ["Rex.app", "Rex Beta.app"])
        candidates.push(join(directory, app, "Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"));
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);

      return candidate;
    } catch {
      /* Try the next installation. */
    }
  }

  return undefined;
}

/** Local registration is optional; a ready sandbox remains usable if Rex is unavailable. */
export async function registerRexHost(
  label: string,
  address: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  out: Pick<Output, "note">,
  dependencies: { find?: typeof findRex; run?: RexRun } = {},
): Promise<void> {
  try {
    const binary = await (dependencies.find ?? findRex)(env);

    if (!binary) {
      out.note("rex: local CLI not found; add the connection address in Rex with Add Remote Host…");

      return;
    }

    const run = dependencies.run ?? runner(env, signal);

    // Let the hosts command check support at the destination: it routes the addition
    // to the user's home, regardless of REX_SERVER.
    await run(binary, ["hosts", "add", label, address]);
    out.note(`rex: registered ${label} with your Rex home`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    out.note(
      `rex: automatic host registration failed: ${message}; add the connection address manually`,
    );
  }
}
