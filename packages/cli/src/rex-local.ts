import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { Output } from "./output";

export type RexRun = (binary: string, args: string[]) => Promise<string>;

/** Where the Rex docs say `rex hosts` is CLI-only for now. */
export const REX_HOSTS_DOCS =
  "https://www.superlogical.com/rex/docs/linux/remote-access#adding-the-server-to-a-client";

/** A failed `rex` command, described by the first line it wrote to stderr. */
export class RexCommandError extends Error {
  override name = "RexCommandError";
}

/** The first non-empty line of a command's stderr, without Rex's `Error: ` prefix. */
export function firstLine(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);

  return line?.replace(/^Error:\s*/, "");
}

function runner(env: NodeJS.ProcessEnv, signal: AbortSignal): RexRun {
  return (binary, args) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        binary,
        args,
        { env, signal, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);

          if (error.name === "AbortError") return reject(error);

          const detail = firstLine(String(stderr)) ?? firstLine(error.message) ?? "rex failed";
          reject(new RexCommandError(detail, { cause: error }));
        },
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

/** The part of `rex hosts --json` the CLI reads; Rex may add fields. */
const HostList = z.object({
  hosts: z.array(
    z.object({
      host: z.object({ label: z.string(), endpoints: z.array(z.string()).default([]) }),
      held: z.boolean().default(false),
    }),
  ),
});

interface RexHost {
  label: string;
  endpoints: string[];
  held: boolean;
}

/** `rex hosts --json`, or undefined when this Rex can't list hosts as JSON. */
async function listHosts(run: RexRun, binary: string): Promise<RexHost[] | undefined> {
  let text: string;

  try {
    text = await run(binary, ["hosts", "--json"]);
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;

    return undefined;
  }

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }

  const parsed = HostList.safeParse(json);

  if (!parsed.success) return undefined;

  return parsed.data.hosts.map(({ host, held }) => ({ ...host, held }));
}

function sameLabel(host: RexHost, label: string): boolean {
  return host.label.toLowerCase() === label.toLowerCase();
}

function aborted(signal: AbortSignal, cause: unknown): boolean {
  return signal.aborted || (cause instanceof Error && cause.name === "AbortError");
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Save the instance as a `rex hosts` label so `rex -S <label>` reaches it. Rex keeps these
 * hosts for the CLI only; the Rex app's sidebar needs Add Remote Host…. Best effort: a ready
 * sandbox remains usable if Rex is unavailable.
 */
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

    // The hosts command routes the change to the user's home, regardless of REX_SERVER.
    const existing = (await listHosts(run, binary))?.find((host) => sameLabel(host, label));

    if (!existing) await run(binary, ["hosts", "add", label, address]);
    // A label left behind by an earlier sandbox of the same name: point it at this one.
    else if (existing.endpoints.length !== 1 || existing.endpoints[0] !== address)
      await run(binary, ["hosts", "edit", existing.label, "--endpoint", address]);

    const held = (await listHosts(run, binary))?.find((host) => sameLabel(host, label))?.held;

    out.note(
      held
        ? `rex: saved ${label} for the rex CLI; it reaches your Rex home the next time rex hosts can`
        : `rex: saved ${label} for the rex CLI (rex -S ${label})`,
    );
    out.note(`rex: to open it in the Rex app, use Add Remote Host… (${REX_HOSTS_DOCS})`);
  } catch (cause) {
    if (aborted(signal, cause)) return;

    out.note(
      `rex: could not save ${label} for the rex CLI (${describe(cause)}); add the connection address in Rex with Add Remote Host…`,
    );
  }
}

/** Remove the label `registerRexHost` saved, if it still points at this sandbox. Best effort. */
export async function unregisterRexHost(
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

    if (!binary) return;

    const run = dependencies.run ?? runner(env, signal);

    const existing = (await listHosts(run, binary))?.find((host) => sameLabel(host, label));

    // Leave a label the user has since pointed somewhere else.
    if (!existing?.endpoints.includes(address)) return;

    await run(binary, ["hosts", "remove", existing.label]);
    out.note(`rex: removed ${existing.label} from your rex hosts`);
  } catch (cause) {
    if (aborted(signal, cause)) return;

    out.note(`rex: could not remove ${label} from your rex hosts (${describe(cause)})`);
  }
}
