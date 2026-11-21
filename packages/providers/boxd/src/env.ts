import { AdapterError } from "@beachside/adapter";

/**
 * Sandbox-wide environment. boxd's create-time `env` does not reach exec sessions on a machine
 * booted from an image, and a machine spec cannot name an image, so the adapter writes the
 * variables to this file, private to the exec user, right after create, and every user command
 * sources it first. It lives in that user's home: boxd's default image runs exec as the
 * unprivileged `boxd` user, who cannot write `/etc`. A fork or snapshot restore copies the file
 * with the disk, so it keeps the env it was made with.
 */
export const ENV_FILE = '"$HOME/.beachside.env"';

/** boxd's own limits for machine env, kept so the file stays within what a machine may hold. */
const MAX_VARIABLES = 128;

const MAX_VALUE_BYTES = 32 * 1024;

const MAX_TOTAL_BYTES = 256 * 1024;

const EnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote one word for POSIX sh; the only special character inside quotes is `'`. */
function quote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Throws before any effect when the env cannot be written: POSIX names, no NUL, boxd's size
 * limits. Messages name the variable, never its value.
 */
export function checkEnv(env: Record<string, string> | undefined): void {
  if (!env) return;

  const entries = Object.entries(env);

  if (entries.length > MAX_VARIABLES)
    throw new AdapterError(
      "INVALID_ARGUMENT",
      `boxd sandboxes hold at most ${MAX_VARIABLES} env variables`,
    );

  let total = 0;

  for (const [name, value] of entries) {
    if (!EnvKey.test(name))
      throw new AdapterError("INVALID_ARGUMENT", "Environment variable names must be POSIX names");

    if (value.includes("\0"))
      throw new AdapterError("INVALID_ARGUMENT", `Environment variable ${name} contains NUL`);

    const bytes = new TextEncoder().encode(value).byteLength;
    total += bytes;

    if (bytes > MAX_VALUE_BYTES)
      throw new AdapterError("INVALID_ARGUMENT", `Environment variable ${name} is over 32 KiB`);
  }

  if (total > MAX_TOTAL_BYTES)
    throw new AdapterError("INVALID_ARGUMENT", "boxd sandbox env is over 256 KiB in all");
}

/** The env file: one quoted export per variable. */
export function envFile(env: Record<string, string>): Uint8Array {
  const lines = Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}`);

  return new TextEncoder().encode([...lines, ""].join("\n"));
}

/** Writes the env file from stdin, private to its owner, replacing it in one rename. */
export const WRITE_ENV_FILE = [
  "/bin/sh",
  "-c",
  'umask 077 && cat >"$HOME/.beachside.env.tmp" && mv -f "$HOME/.beachside.env.tmp" "$HOME/.beachside.env"',
];

/**
 * A user command behind a sh prelude that sources the env file. The command's own env still wins:
 * its variables arrive through the native exec env, are saved before the file is sourced and
 * restored after. The prelude names them but never holds their values.
 */
export function withSandboxEnv(
  argv: readonly string[],
  callEnv: Record<string, string> | undefined,
): string[] {
  const names = Object.keys(callEnv ?? {}).filter((name) => EnvKey.test(name));
  const saved = (index: number) => `beachside_${index}`;
  const save = names.map((name, index) => `${saved(index)}=$${name}; `).join("");

  const restore = names.length
    ? `${names.map((name, index) => `${name}=$${saved(index)}`).join("; ")}; export ${names.join(" ")}; unset ${names.map((_, index) => saved(index)).join(" ")}; `
    : "";

  return [
    "/bin/sh",
    "-c",
    `${save}if [ -r ${ENV_FILE} ]; then . ${ENV_FILE}; fi; ${restore}exec "$@"`,
    "beachside",
    ...argv,
  ];
}
