import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Output } from "./output";

export type RexRun = (binary: string, args: string[]) => Promise<string>;

function runner(env: NodeJS.ProcessEnv, signal: AbortSignal): RexRun {
  return (binary, args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { env, signal, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );

      child.stdin?.end();
    });
}

/** Prefer an explicit executable, then PATH, then the macOS app's bundled CLI. */
export async function findRex(
  env: NodeJS.ProcessEnv,
  installation: { platform?: NodeJS.Platform; appDirectories?: string[] } = {},
): Promise<string | undefined> {
  if (env.BEACHSIDE_REX_BIN) return env.BEACHSIDE_REX_BIN;

  const platform = installation.platform ?? process.platform;

  const candidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, platform === "win32" ? "rex.exe" : "rex"));

  if (platform === "darwin") {
    for (const directory of installation.appDirectories ?? [
      "/Applications",
      join(env.HOME ?? homedir(), "Applications"),
    ]) {
      for (const app of ["Rex.app", "Rex Beta.app"])
        candidates.push(join(directory, app, "Contents/Helpers/Rex Server.rex/Contents/MacOS/rex"));
    }
  }

  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;

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
  if (signal.aborted) return;

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
    if (signal.aborted || (cause instanceof Error && cause.name === "AbortError")) return;

    const message = cause instanceof Error ? cause.message : String(cause);
    out.note(
      `rex: automatic host registration failed: ${message}; add the connection address manually`,
    );
  }
}
