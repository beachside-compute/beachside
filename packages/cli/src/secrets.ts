import { execFile, spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Json } from "@beachside/adapter";
import { z } from "zod";
import type { Env } from "./config";
import { CliError } from "./output";

/** A password manager whose CLI can read one secret by reference. */
type SecretBackend = {
  name: string;
  /** Matches the whole reference string. */
  pattern: RegExp;
  command: string;
  args: (reference: string) => string[];
  value: (stdout: string) => string;
  install: string;
  check: string;
};

const BwsSecret = z.object({ value: z.string() });

/** `keychain://<service>/<account>`: one generic password in the OS keychain. */
const KeychainReference = /^keychain:\/\/([\w.@+-]{1,128})\/([\w.@+-]{1,160})$/;

/** The OS keychain tool: macOS `security`, or Secret Service through `secret-tool` elsewhere. */
function keychainBackend(platform: NodeJS.Platform): SecretBackend {
  const parts = (reference: string) => {
    const [, service, account] = KeychainReference.exec(reference)!;

    return { service: service!, account: account! };
  };

  return platform === "darwin"
    ? {
        name: "macOS Keychain",
        pattern: KeychainReference,
        command: "security",
        args: (reference) => {
          const { service, account } = parts(reference);

          return ["find-generic-password", "-s", service, "-a", account, "-w"];
        },
        value: (stdout) => stdout.replace(/\n$/, ""),
        install: "macOS Keychain is read with `security`, which ships with macOS",
        check: "check that the keychain is unlocked and the item exists (Keychain Access)",
      }
    : {
        name: "Secret Service keyring",
        pattern: KeychainReference,
        command: "secret-tool",
        args: (reference) => {
          const { service, account } = parts(reference);

          return ["lookup", "service", service, "account", account];
        },
        value: (stdout) => {
          if (!stdout) throw new Error("no such item");

          return stdout.replace(/\n$/, "");
        },
        install:
          "install secret-tool (libsecret-tools on Debian and Ubuntu, libsecret on Fedora) and a keyring such as GNOME Keyring",
        check:
          "check that the keyring is unlocked and the item exists (`secret-tool lookup service <service> account <account>`)",
      };
}

const backends: SecretBackend[] = [
  {
    // op://vault/item/field or op://vault/item/section/field
    name: "1Password",
    pattern: /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}(\?\S*)?$/,
    command: "op",
    args: (reference) => ["read", "--no-newline", reference],
    value: (stdout) => stdout,
    install: "install the 1Password CLI (https://developer.1password.com/docs/cli) and sign in",
    check: "check `op whoami` and that the vault, item and field exist",
  },
  {
    // bws://<secret-id>, read with BWS_ACCESS_TOKEN
    name: "Bitwarden Secrets Manager",
    pattern: /^bws:\/\/[0-9a-fA-F-]{36}$/,
    command: "bws",
    args: (reference) => ["secret", "get", reference.slice("bws://".length), "--output", "json"],
    value: (stdout) => BwsSecret.parse(JSON.parse(stdout)).value,
    install:
      "install the Bitwarden Secrets Manager CLI (https://bitwarden.com/help/secrets-manager-cli/) and set BWS_ACCESS_TOKEN",
    check: "check BWS_ACCESS_TOKEN and that the machine account can read the secret",
  },
  {
    // pass://path/in/store; the first line of the entry, as `pass -c` would copy
    name: "pass",
    pattern: /^pass:\/\/(?!.*(^|\/)\.\.(\/|$))[\w@+.-]+(\/[\w@+.-]+)*$/,
    command: "pass",
    args: (reference) => ["show", reference.slice("pass://".length)],
    value: (stdout) => stdout.split("\n")[0] ?? "",
    install: "install pass (https://www.passwordstore.org) and initialise your store",
    check: "check that `pass show <path>` works, including the GPG agent",
  },
  keychainBackend(process.platform),
];

function backendFor(value: string): SecretBackend | undefined {
  return backends.find((backend) => backend.pattern.test(value));
}

/**
 * The `keychain://` reference init writes for one profile value. Keychain items are global to
 * the user, so `id` (fresh for each write) keeps two config files, or a replaced profile and its
 * replacement, from sharing or overwriting one item.
 */
export function keychainReference(profile: string, key: string, id: string): string {
  return `keychain://beachside/${profile}.${key}.${id}`;
}

/** Whether a reference names an item `init` created, so `init` may remove it when replaced. */
export function ownKeychainReference(reference: string): boolean {
  return /^keychain:\/\/beachside\/[\w.@+-]+$/.test(reference) && KeychainReference.test(reference);
}

async function onPath(command: string, env: Env): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;

    try {
      await access(join(dir, command), constants.X_OK);

      return true;
    } catch {
      // Not in this folder.
    }
  }

  return false;
}

/** The OS keychain this machine can store new keys in, or null when there is none. */
export async function keychainAvailable(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "darwin" && platform !== "linux" && platform !== "freebsd") return null;
  const backend = keychainBackend(platform);

  return (await onPath(backend.command, env)) ? backend.name : null;
}

/** A value `security -i` can take inside double quotes without changing it. */
const SafeForSecurity = /^[\x20-\x7e]*$/;

/**
 * Store one secret in the OS keychain under `reference`, replacing an earlier one. The value goes
 * to the tool on stdin, never in its arguments, so other processes can't read it from `ps`.
 */
export async function storeInKeychain(
  reference: string,
  value: string,
  env: Env,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const match = KeychainReference.exec(reference);

  if (!match) throw new CliError("USAGE", `${reference} is not a keychain:// reference`);
  const [, service, account] = match;
  const backend = keychainBackend(platform);
  let args: string[];
  let input: string;

  if (platform === "darwin") {
    if (!SafeForSecurity.test(value) || /["\\]/.test(value))
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `This key has characters the macOS Keychain tool can't take safely (${reference})`,
        "keep it in beachside.json or a password manager instead",
      );
    args = ["-i"];
    input = `add-generic-password -U -s "${service}" -a "${account}" -l "beachside ${account}" -w "${value}"\n`;
  } else {
    args = ["store", `--label=beachside ${account}`, "service", service!, "account", account!];
    input = value;
  }

  const result = await keychainTool(backend.command, args, input, env, signal);

  // A store stopped by Ctrl-C is an interruption, not a keychain failure.
  if (signal.aborted) throw new CliError("INTERRUPTED", "Interrupted; nothing was saved");

  if (result.code === "ENOENT")
    throw new CliError(
      "SECRET_TOOL_MISSING",
      `Cannot store keys in the keychain: \`${backend.command}\` is not installed`,
      backend.install,
    );

  if (result.code !== 0)
    throw new CliError(
      "SECRET_UNAVAILABLE",
      // The tool's own output is left out: on macOS it may echo the command, key included.
      `Cannot store ${reference} in the ${backend.name}: ${backend.command} exited with ${result.code}`,
      backend.check,
    );
}

/** Remove one item `storeInKeychain` made; false when the tool could not remove it. */
export async function removeFromKeychain(
  reference: string,
  env: Env,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const match = KeychainReference.exec(reference);

  if (!match) return false;
  const [, service, account] = match;
  const backend = keychainBackend(platform);

  const args =
    platform === "darwin"
      ? ["delete-generic-password", "-s", service!, "-a", account!]
      : ["clear", "service", service!, "account", account!];

  const result = await keychainTool(backend.command, args, "", env, signal);

  return result.code === 0;
}

/** Run a keychain tool with `input` on stdin; its stdout is ignored, since it may hold a secret. */
function keychainTool(
  command: string,
  args: string[],
  input: string,
  env: Env,
  signal: AbortSignal,
): Promise<RunResult> {
  return new Promise<RunResult>((done) => {
    const child = spawn(command, args, {
      env: { ...env },
      signal,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    child.stdout.resume();
    child.on("error", (cause) =>
      done({ code: "code" in cause ? String(cause.code) : "FAILED", stdout: "", stderr }),
    );
    child.on("close", (code) => done({ code: code ?? "FAILED", stdout: "", stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** The password manager a reference reads from, such as 1Password; null for any other value. */
export function secretManager(value: string): string | null {
  return backendFor(value)?.name ?? null;
}

type RunResult = { code: number | string; stdout: string; stderr: string };

function run(command: string, args: string[], env: Env, signal: AbortSignal): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { env: { ...env }, signal, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error ? (error.code ?? "FAILED") : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

/**
 * Reads password-manager references (`op://...`, `bws://...`, `pass://...`, `keychain://...`) through the manager's own CLI
 * when a profile connects, so secrets never need to be written into beachside.json. The CLI uses
 * its own sign-in. Each reference is read at most once per invocation and never stored.
 */
export class SecretReader {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly env: Env,
    private readonly signal: AbortSignal,
  ) {}

  private read(backend: SecretBackend, reference: string, where: string): Promise<string> {
    let pending = this.cache.get(reference);

    if (!pending) {
      pending = this.fetch(backend, reference, where);
      this.cache.set(reference, pending);
    }

    return pending;
  }

  private async fetch(backend: SecretBackend, reference: string, where: string): Promise<string> {
    const result = await run(backend.command, backend.args(reference), this.env, this.signal);

    if (result.code === "ENOENT")
      throw new CliError(
        "SECRET_TOOL_MISSING",
        `${where} is a ${backend.name} reference, but \`${backend.command}\` is not installed`,
        backend.install,
      );

    // Only the manager's own diagnostics are shown; stdout may hold the secret.
    if (result.code !== 0)
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `Cannot read ${where} from ${backend.name} (${reference}): ${result.stderr.trim() || `${backend.command} exited with ${result.code}`}`,
        backend.check,
      );

    try {
      return backend.value(result.stdout);
    } catch {
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `${backend.name} returned an unreadable answer for ${where} (${reference})`,
        backend.check,
      );
    }
  }

  /** Replace every password-manager reference inside a config or credentials value. */
  async resolve(value: Json, where: string): Promise<Json> {
    const text = z.string().safeParse(value);

    if (text.success) {
      const backend = backendFor(text.data);

      return backend ? this.read(backend, text.data, where) : value;
    }

    if (Array.isArray(value))
      return Promise.all(value.map((item, index) => this.resolve(item, `${where}[${index}]`)));

    const record = z.record(z.string(), z.json()).safeParse(value);

    if (record.success)
      return Object.fromEntries(
        await Promise.all(
          Object.entries(record.data).map(
            async ([key, item]) => [key, await this.resolve(item, `${where}.${key}`)] as const,
          ),
        ),
      );

    return value;
  }
}
