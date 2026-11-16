import { isAbsolute, resolve } from "node:path";
import type { AdapterSetup, Json } from "@beachside/adapter";
import type { BeachsideClient } from "beachside";
import { z } from "zod";
import { installAdapters } from "./adapters";
import { runWizard } from "./init-wizard";
import { checkCredentials, type CredentialCheck, type Flags } from "./commands";
import {
  CONFIG_SCHEMA_URL,
  searchProjectAdapters,
  type LoadedConfig,
  type ProfileConfig,
} from "./config";
import { CliError, describeError, usage } from "./output";
import { updateConfig } from "./profiles";
import {
  adapterSetup,
  descriptor,
  providers,
  resolveAdapterModule,
  resolveProfile,
  type AdapterLocation,
  type OfficialProvider,
} from "./providers";
import { randomBytes } from "node:crypto";
import { chmod } from "node:fs/promises";
import {
  keychainAvailable,
  keychainReference,
  ownKeychainReference,
  removeFromKeychain,
  secretManager,
  storeInKeychain,
} from "./secrets";
import type { Session } from "./session";
import { shellQuote } from "./transfer";
import { parsePairs } from "./units";

/** The adapter a profile is set up for: an official provider, or any adapter module. */
export type InitTarget = {
  /** The official provider id, or the profile name for another adapter. */
  id: string;
  official: OfficialProvider | null;
  module: string;
  export: string;
  /** How the wizard names it, such as "boxd" or "E2B". */
  label: string;
};

const labels = new Map([
  ["boxd", "boxd"],
  ["freestyle", "Freestyle"],
  ["daytona", "Daytona"],
  ["e2b", "E2B"],
  ["vercel", "Vercel"],
  ["boat", "Boat"],
  ["runloop", "Runloop"],
  ["archil", "Archil"],
  ["exe-dev", "exe.dev"],
  ["modal", "Modal"],
]);

export function officialTarget(provider: OfficialProvider): InitTarget {
  return {
    id: provider.id,
    official: provider,
    module: provider.module,
    export: provider.export,
    label: labels.get(provider.id) ?? provider.id,
  };
}

/** Where new plain keys go: the OS keychain, or beachside.json itself (mode 0600). */
export type Storage = "keychain" | "config";

const ProfileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkProfileName(name: string): string {
  if (!ProfileName.test(name))
    throw usage(
      `Profile name ${name} is not usable`,
      "use letters, digits, dot, dash or underscore, up to 64 characters",
    );

  return name;
}

const EnvReference = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

/** A value that points at a secret rather than being one: env:NAME or a password-manager reference. */
export function isReference(value: string): boolean {
  return EnvReference.test(value) || secretManager(value) !== null;
}

/** One profile `init` is about to write, before its new keys have a home. */
export type Draft = {
  name: string;
  target: InitTarget;
  setup: AdapterSetup | null;
  /** Credentials that are references (env:, op://, keychain:// ...) or kept from the old profile. */
  credentials: Record<string, string>;
  /** New plain keys by credential key; stored where the person chose when the profile is written. */
  secrets: Record<string, string>;
  config: Record<string, Json>;
  /** The profile this one replaces, if any. */
  previous: ProfileConfig | null;
  /** Fresh for each run, so new keychain items never overwrite or share another config's. */
  keychainId: string;
};

/** A short random id for this run's keychain items. */
export function newKeychainId(): string {
  return randomBytes(4).toString("hex");
}

/** Where one new key is stored in the keychain. */
function keychainRef(draft: Draft, key: string): string {
  return keychainReference(draft.name, key, draft.keychainId);
}

/**
 * A key given again that is what the profile already stores keeps its current place, so rerunning
 * the same command reports `unchanged` instead of storing the key a second time.
 */
export async function keepSameKeys(session: Session, draft: Draft): Promise<void> {
  for (const [key, value] of Object.entries(draft.secrets)) {
    const current = draft.previous?.credentials?.[key];

    if (current === undefined) continue;
    let same = current === value;

    if (!same && ownKeychainReference(current))
      try {
        same =
          (await session.secret(current, `profiles.${draft.name}.credentials.${key}`)) === value;
      } catch {
        // The old item can't be read; the new key is stored as a new one.
      }

    if (same) {
      draft.credentials[key] = current;
      delete draft.secrets[key];
    }
  }
}

/** The profile as it will be written, with new keys replaced by where they are stored. */
export function profileFor(draft: Draft, storage: Storage): ProfileConfig {
  const stored = Object.fromEntries(
    Object.entries(draft.secrets).map(([key, value]) => [
      key,
      storage === "keychain" ? keychainRef(draft, key) : value,
    ]),
  );

  const credentials = { ...draft.credentials, ...stored };

  const profile: ProfileConfig = draft.target.official
    ? { provider: draft.target.official.id }
    : { module: draft.target.module, export: draft.target.export };

  if (Object.keys(draft.config).length) profile.config = draft.config;

  if (Object.keys(credentials).length) profile.credentials = credentials;

  // Default setups the person listed stay with the profile.
  if (draft.previous?.setup?.length) profile.setup = draft.previous.setup;

  return profile;
}

/** Whether the adapter can be loaded now, from the adapters folder or the CLI's own modules. */
export async function adapterInstalled(
  target: InitTarget,
  loaded: LoadedConfig,
  session: Session,
): Promise<boolean> {
  const { env, cwd } = session.ctx;

  const resolved = await resolveAdapterModule(
    {
      name: target.id,
      provider: target.id,
      module: target.module,
      export: target.export,
      baseDir: loaded.dir,
      searchProject: searchProjectAdapters(loaded, env),
      config: {},
      credentials: {},
    },
    cwd,
    env,
  );

  if (resolved !== target.module) return true;

  try {
    import.meta.resolve(target.module);

    return true;
  } catch {
    return false;
  }
}

export function location(
  target: InitTarget,
  loaded: LoadedConfig,
  session: Session,
): AdapterLocation {
  return {
    name: target.id,
    module: target.module,
    export: target.export,
    baseDir: loaded.dir,
    searchProject: searchProjectAdapters(loaded, session.ctx.env),
  };
}

/** Install the official adapters that are missing, in one npm run. */
export async function installMissing(
  session: Session,
  targets: InitTarget[],
  quiet: boolean,
): Promise<string[]> {
  const loaded = await session.config();
  const missing: InitTarget[] = [];

  for (const target of targets)
    if (target.official && !(await adapterInstalled(target, loaded, session))) missing.push(target);

  if (missing.length)
    await installAdapters(
      session,
      missing.map((target) => target.id),
      { quiet },
    );

  return missing.map((target) => target.id);
}

/** What the check of one profile found; a failed profile is reported and not saved. */
export type CheckResult =
  | { status: "ok"; check: CredentialCheck; client: BeachsideClient<true> }
  | { status: "failed"; code: string; reason: string; hint?: string };

/** Connect with the draft profile and make one cheap read, exactly as `doctor` does. */
export async function checkDraft(session: Session, draft: Draft): Promise<CheckResult> {
  const { env, cwd } = session.ctx;
  const loaded = await session.config();

  const withDraft: LoadedConfig = {
    ...loaded,
    value: {
      ...loaded.value,
      // New keys are in place here, held only in memory to check them.
      profiles: { ...loaded.value.profiles, [draft.name]: profileFor(draft, "config") },
    },
  };

  try {
    const resolved = await resolveProfile({ profile: draft.name }, withDraft, env, cwd);
    const client = await session.connect(resolved);
    const check = await checkCredentials(client);

    if (check.status === "rejected")
      return {
        status: "failed",
        code: check.code,
        reason: `${draft.target.label} rejected the key: ${check.reason}`,
        hint: keyLinks(draft.setup),
      };

    if (check.status === "error")
      return { status: "failed", code: check.code, reason: check.reason };

    return { status: "ok", check, client };
  } catch (cause) {
    // Ctrl-C ends the run; it is not a failed check.
    if (session.ctx.signal.aborted) throw cause;
    const report = describeError(cause);

    return { status: "failed", code: report.code, reason: report.message, hint: report.hint };
  }
}

function keyLinks(setup: AdapterSetup | null): string | undefined {
  const links = Object.values(setup?.credentials ?? {}).flatMap((value) =>
    value.url ? [`${value.env}: ${value.url}`] : [],
  );

  return links.length ? `get a new key here: ${links.join("; ")}` : undefined;
}

export type TryResult =
  | { status: "ok"; seconds: number }
  | { status: "failed"; code: string; reason: string; leftover: string | null };

/** Create a sandbox, run one command in it and destroy it. */
export async function trySandbox(
  session: Session,
  client: BeachsideClient<true>,
): Promise<TryResult> {
  const signal = session.ctx.signal;
  const started = Date.now();
  let box: Awaited<ReturnType<typeof client.sandboxes.create>>;

  try {
    box = await client.sandboxes.create({}, { signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    const report = describeError(cause);

    return {
      status: "failed",
      code: report.code,
      reason: report.message,
      leftover: report.known?.reference?.nativeId ?? null,
    };
  }

  let failure: { code: string; reason: string } | null = null;
  let interrupted = false;

  try {
    const result = await box.exec(
      { command: { kind: "argv", argv: ["echo", "beachside"] } },
      { signal },
    );

    if (result.exitCode !== 0)
      failure = { code: "EXEC_FAILED", reason: `a test command exited with ${result.exitCode}` };
  } catch (cause) {
    const report = describeError(cause);
    failure = { code: report.code, reason: report.message };

    if (signal.aborted) interrupted = true;
  }

  // The test sandbox is destroyed even after Ctrl-C, then the interruption ends the run.
  try {
    await box.destroy();
  } catch (cause) {
    const report = describeError(cause);

    return {
      status: "failed",
      code: report.code,
      reason: `${failure ? `${failure.reason}; ` : ""}the test sandbox could not be destroyed: ${report.message}`,
      leftover: box.reference?.nativeId ?? null,
    };
  }

  if (interrupted) throw new CliError("INTERRUPTED", "Interrupted; the test sandbox was destroyed");

  return failure
    ? { status: "failed", ...failure, leftover: null }
    : { status: "ok", seconds: Math.round((Date.now() - started) / 100) / 10 };
}

/**
 * Store new keys, then write every profile and the default in one change to beachside.json.
 * Nothing is written before this, so a cancelled or failed run leaves the file as it was. New
 * keychain items get fresh names, so the old profile keeps working until the file is replaced;
 * if the file can't be written they are removed again, and once it is, the items the replaced
 * profiles used are removed.
 */
export async function writeProfiles(
  session: Session,
  drafts: Draft[],
  storage: Storage,
  defaultName: string | null,
): Promise<void> {
  const { env, signal } = session.ctx;

  // Ctrl-C at any earlier step, even one that caught it, saves nothing.
  if (signal.aborted) throw new CliError("INTERRUPTED", "Interrupted; nothing was saved");
  const loaded = await session.config();
  const stored: string[] = [];

  const rollBack = async () => {
    for (const reference of stored) await removeFromKeychain(reference, env, signal);
  };

  try {
    if (storage === "keychain")
      for (const draft of drafts)
        for (const [key, value] of Object.entries(draft.secrets)) {
          const reference = keychainRef(draft, key);
          await storeInKeychain(reference, value, env, signal);
          stored.push(reference);
        }

    // A file that will hold a key itself becomes readable only by you, even if it wasn't.
    const plain = drafts.some(
      (draft) =>
        (storage === "config" && Object.keys(draft.secrets).length > 0) ||
        Object.values(draft.credentials).some((value) => !isReference(value)),
    );

    if (plain && loaded.exists) await chmod(loaded.path, 0o600);

    await updateConfig(loaded.path, (raw) => {
      const profiles = z.record(z.string(), z.json()).parse(raw.profiles ?? {});

      for (const draft of drafts) profiles[draft.name] = profileFor(draft, storage);

      const next: typeof raw = { $schema: raw.$schema ?? CONFIG_SCHEMA_URL, ...raw, profiles };

      if (defaultName) next.default = defaultName;

      return next;
    });
  } catch (cause) {
    await rollBack();
    throw cause;
  }

  // Keychain items the replaced profiles used and no longer do.
  for (const draft of drafts) {
    const now = new Set(Object.values(profileFor(draft, storage).credentials ?? {}));

    for (const old of Object.values(draft.previous?.credentials ?? {}))
      if (ownKeychainReference(old) && !now.has(old)) await removeFromKeychain(old, env, signal);
  }
}

const PlainWord = /^[\w@%+=:,./-]+$/;

function quote(value: string): string {
  return PlainWord.test(value) ? value : shellQuote(value);
}

/** The flag that sets one credential: --api-key for apiKey, --credential for the rest. */
function credentialFlag(key: string, value: string): string[] {
  return key === "apiKey"
    ? ["--api-key", quote(value)]
    : ["--credential", quote(`${key}=${value}`)];
}

function configFlag(key: string, value: Json): string[] {
  const text = z.string().safeParse(value);

  if (key === "network" && text.success) return ["--network", quote(text.data)];

  // A string that would read back as JSON (true, 3, null) is written as a JSON string.
  const plain =
    text.success && JSON.stringify(configValue(text.data)) === JSON.stringify(text.data);

  return ["--set", quote(`${key}=${plain ? text.data : JSON.stringify(value)}`)];
}

/**
 * The non-interactive command that makes this profile again. A key stored in beachside.json is
 * never printed: the command reads it from stdin (`--api-key -`), one line per `-` when there are
 * several, in the order the flags are printed.
 */
export function equivalentCommand(draft: Draft, storage: Storage, isDefault: boolean): string {
  const parts = ["beachside", "init"];

  if (draft.target.official) parts.push(draft.target.official.id);
  else parts.push("--module", quote(draft.target.module), "--export", quote(draft.target.export));

  if (!draft.target.official || draft.name !== draft.target.official.id)
    parts.push("--profile", quote(draft.name));

  // A key kept from beachside.json is never printed either.
  const values = new Map<string, string>();

  for (const [key, value] of Object.entries(draft.credentials))
    values.set(key, isReference(value) ? value : "-");

  for (const key of Object.keys(draft.secrets))
    values.set(key, storage === "keychain" ? keychainRef(draft, key) : "-");

  // --api-key comes first, the order `init` reads several piped values in.
  const ordered = [...values].sort(([a], [b]) => Number(b === "apiKey") - Number(a === "apiKey"));

  for (const [key, value] of ordered) parts.push(...credentialFlag(key, value));

  // Piped keys go back where they were: beachside.json.
  if (ordered.some(([, value]) => value === "-")) parts.push("--store", "config");

  const defaults = draft.setup?.defaults ?? {};

  for (const [key, value] of Object.entries(draft.config))
    if (JSON.stringify(defaults[key]) !== JSON.stringify(value))
      parts.push(...configFlag(key, value));

  if (isDefault) parts.push("--default");

  return parts.join(" ");
}

/** Where each credential of the written profile comes from, never a key itself. */
export function credentialSources(draft: Draft, storage: Storage) {
  return {
    ...Object.fromEntries(
      Object.entries(draft.credentials).map(([key, value]) => [
        key,
        isReference(value) ? value : "beachside.json",
      ]),
    ),
    ...Object.fromEntries(
      Object.keys(draft.secrets).map((key) => [
        key,
        storage === "keychain" ? keychainRef(draft, key) : "beachside.json",
      ]),
    ),
  };
}

/** Every setting of a profile by name, such as `config.org`, with its value as JSON text. */
function settings(profile: ProfileConfig): Map<string, string> {
  const entries: [string, string][] = [];

  for (const key of ["provider", "module", "export"] as const) {
    const value = profile[key];

    if (value !== undefined) entries.push([key, value]);
  }

  for (const [key, value] of Object.entries(profile.config ?? {}))
    entries.push([`config.${key}`, JSON.stringify(value)]);

  for (const [key, value] of Object.entries(profile.credentials ?? {}))
    entries.push([`credentials.${key}`, value]);

  return new Map(entries);
}

/** The settings that differ between an existing profile and its replacement, by name. */
export function changedSettings(previous: ProfileConfig, next: ProfileConfig): string[] {
  const before = settings(previous);
  const after = settings(next);

  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (key) => before.get(key) !== after.get(key),
  );
}

/** Parse a `--set` value: JSON when it is JSON (true, 3, {"kind":...}), else the text itself. */
export function configValue(text: string): Json {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return text;
  }
}

/** Whether `init` may ask questions: a person at a terminal, with nothing asking it not to. */
export function interactive(session: Session, flags: Flags): boolean {
  const { env, out, terminal } = session.ctx;
  const off = (value: string | undefined) => value === "1" || value === "true";

  return (
    terminal === true &&
    !out.json &&
    !flags.bool("no-input") &&
    !off(env.BEACHSIDE_NO_INPUT) &&
    !(env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false")
  );
}

/** The adapter named on the command line: an official id, or --module with --export. */
export function targetFromFlags(
  session: Session,
  flags: Flags,
  id: string | undefined,
): InitTarget | null {
  const module = flags.string("module");

  if (module) {
    if (id) throw usage("Pass a provider id or --module, not both");
    const name = flags.string("profile");

    if (!name) throw usage("--module needs --profile <name> for the new profile");

    const path =
      module.startsWith(".") || isAbsolute(module) ? resolve(session.ctx.cwd, module) : module;

    return {
      id: checkProfileName(name),
      official: null,
      module: path,
      export: flags.string("export") ?? "default",
      label: name,
    };
  }

  if (flags.has("export")) throw usage("--export applies only with --module");

  if (!id) return null;
  const official = descriptor(id);

  if (!official)
    throw usage(
      `Unknown provider ${id}`,
      `official providers: ${providers.map((provider) => provider.id).join(", ")}; for another adapter pass --module <package|path> --export <name> --profile <name>`,
    );

  return officialTarget(official);
}

const piped = new WeakMap<Session, Promise<string>>();

/**
 * Start reading stdin when a flag asks for `-`, before anything else runs, so the key is taken
 * while the pipe is fresh; the value is used once the adapter's setup says where it goes.
 */
export function readPipedKey(session: Session, flags: Flags): void {
  const values = [
    flags.string("api-key"),
    ...flags.strings("credential").map((pair) => pair.slice(pair.indexOf("=") + 1)),
  ];

  if (values.includes("-") && !piped.has(session)) {
    const reading = readStdin(session);
    // The read is awaited later; an early failure is reported then, not as an unhandled rejection.
    reading.catch(() => undefined);
    piped.set(session, reading);
  }
}

/** Read stdin for `-` values, without a trailing newline. */
async function readStdin(session: Session): Promise<string> {
  const parts: Uint8Array[] = [];

  for await (const chunk of session.ctx.stdin()) parts.push(chunk);

  const value = Buffer.concat(parts)
    .toString("utf8")
    .replace(/\r?\n$/, "");

  if (!value) throw usage("A credential given as - read nothing from stdin");

  return value;
}

/** Values the flags give, by credential and config key. */
export type Given = { credentials: Record<string, string>; config: Record<string, Json> };

export async function givenValues(
  session: Session,
  flags: Flags,
  setup: AdapterSetup | null,
): Promise<Given> {
  const pairs = parsePairs(flags.strings("credential"), "credential");
  const credentials: Record<string, string> = {};
  const apiKey = flags.string("api-key");

  if (apiKey !== undefined) {
    const keys = Object.keys(setup?.credentials ?? {});

    if (keys.length > 1 && !keys.includes("apiKey"))
      throw usage(
        "This adapter has no single API key",
        `pass its credentials by name: ${keys.map((key) => `--credential ${key}=...`).join(" ")}`,
      );

    const key = keys.length === 1 ? keys[0]! : "apiKey";

    if (pairs[key] !== undefined) throw usage(`--api-key and --credential ${key} both set ${key}`);
    credentials[key] = apiKey;
  }

  // --api-key first, then each --credential in order: the order several piped values are read in.
  Object.assign(credentials, pairs);
  const reading = Object.keys(credentials).filter((key) => credentials[key] === "-");

  if (reading.length) {
    const text = await (piped.get(session) ?? readStdin(session));
    const lines = reading.length > 1 ? text.split(/\r?\n/) : [text];

    if (lines.length !== reading.length || lines.some((line) => !line))
      throw usage(
        `${reading.length} credentials are given as -, so stdin needs ${reading.length} lines, one value each`,
        `the order is ${reading.map((key) => (key === "apiKey" ? "--api-key" : `--credential ${key}`)).join(", ")}`,
      );

    for (const [index, key] of reading.entries()) credentials[key] = lines[index]!;
  }

  const config: Record<string, Json> = Object.fromEntries(
    Object.entries(parsePairs(flags.strings("set"), "set")).map(([key, value]) => [
      key,
      configValue(value),
    ]),
  );

  const network = flags.string("network");

  if (network !== undefined) {
    if (setup && !setup.config?.network)
      throw usage(
        "This adapter has no network setting",
        "use --set <key>=<value> for its own config keys",
      );
    config.network = network;
  }

  return { credentials, config };
}

/** The credential keys to ask for: every plain one, and one group of alternatives. */
export function credentialKeys(setup: AdapterSetup, group: readonly string[] | null): string[] {
  const alternative = new Set((setup.alternatives ?? []).flat());

  return [
    ...Object.keys(setup.credentials).filter((key) => !alternative.has(key)),
    ...(group ?? []),
  ];
}

/** The group of alternatives the flags or environment already fill, else the first one. */
export function chosenGroup(
  setup: AdapterSetup,
  has: (key: string) => boolean,
): readonly string[] | null {
  const groups = setup.alternatives ?? [];

  if (!groups.length) return null;

  return groups.find((group) => group.every(has)) ?? groups[0]!;
}

/** A draft from flags, and the flags neither the command line nor the environment gave. */
export type FlagDraft = { draft: Draft; missing: string[] };

/** Fill a draft from flags and the environment alone; `missing` lists what neither gave. */
export function draftFromFlags(
  name: string,
  target: InitTarget,
  setup: AdapterSetup | null,
  given: Given,
  previous: ProfileConfig | null,
  env: Session["ctx"]["env"],
): FlagDraft {
  const draft: Draft = {
    name,
    target,
    setup,
    credentials: {},
    secrets: {},
    config: {},
    previous,
    keychainId: newKeychainId(),
  };

  const missing: string[] = [];

  const put = (key: string, value: string) => {
    if (isReference(value)) draft.credentials[key] = value;
    else draft.secrets[key] = value;
  };

  // Flags win; values the flags don't name come from the environment or the adapter's defaults.
  for (const [key, value] of Object.entries(given.credentials)) put(key, value);

  if (setup) {
    const group = chosenGroup(
      setup,
      (key) =>
        given.credentials[key] !== undefined ||
        Boolean(setup.credentials[key] && env[setup.credentials[key]!.env]),
    );

    for (const key of credentialKeys(setup, group)) {
      if (given.credentials[key] !== undefined) continue;
      const variable = setup.credentials[key]?.env ?? null;

      if (variable && env[variable]) draft.credentials[key] = `env:${variable}`;
      else
        missing.push(
          key === "apiKey"
            ? `--api-key${variable ? ` (or ${variable})` : ""}`
            : `--credential ${key}=...${variable ? ` (or ${variable})` : ""}`,
        );
    }

    for (const [key, value] of Object.entries(setup.defaults ?? {})) draft.config[key] = value;

    for (const [key, entry] of Object.entries(setup.config ?? {})) {
      if (given.config[key] !== undefined) continue;
      const fromEnv = env[entry.env];

      if (fromEnv) draft.config[key] = fromEnv;
      else if (entry.required && draft.config[key] === undefined)
        missing.push(
          `${key === "network" ? "--network <policy>" : `--set ${key}=...`} (or ${entry.env})`,
        );
    }
  }

  Object.assign(draft.config, given.config);

  return { draft, missing };
}

export const initFlagSpecs = {
  "api-key": {
    type: "string",
    value: "key|ref",
    description:
      "The provider key: a value, - to read it from stdin, env:NAME, or an op://, bws://, pass:// or keychain:// reference",
  },
  credential: {
    type: "string",
    multiple: true,
    value: "key=value",
    description: "Any other credential, with the same value forms (repeatable)",
  },
  set: {
    type: "string",
    multiple: true,
    value: "key=value",
    description: "A config setting, such as target=us; JSON values are parsed (repeatable)",
  },
  network: {
    type: "string",
    value: "policy",
    description: "The profile's network setting, such as internet or blocked",
  },
  store: {
    type: "string",
    value: "keychain|config",
    description:
      "Where a pasted or piped key goes: the OS keychain (default when there is one) or beachside.json (mode 0600)",
  },
  default: { type: "boolean", description: "Make this profile the default" },
  try: {
    type: "boolean",
    description: "Also create a sandbox, run one command and destroy it",
  },
  force: { type: "boolean", description: "Replace a profile of the same name that differs" },
  "no-check": {
    type: "boolean",
    description: "Skip asking the provider whether it accepts the key (offline setup)",
  },
  "no-input": {
    type: "boolean",
    description: "Never ask questions, even in a terminal (also BEACHSIDE_NO_INPUT=1 or CI)",
  },
  module: {
    type: "string",
    value: "package|path",
    description: "Set up another adapter instead of an official provider; needs --profile",
  },
  export: {
    type: "string",
    value: "name",
    description: "The --module export that holds the adapter (default: default)",
  },
} as const;

/** The --store choice, checked. */
export function storeFlag(flags: Flags): Storage | undefined {
  const chosen = flags.string("store");

  if (chosen === undefined || chosen === "keychain" || chosen === "config") return chosen;

  throw usage(`--store is keychain or config, got ${chosen}`);
}

export function noKeychain(): CliError {
  return new CliError(
    "SECRET_TOOL_MISSING",
    "There is no OS keychain to store the key in",
    "macOS has one built in; on Linux install secret-tool (libsecret) and a keyring, or pass --store config",
  );
}

/** Flags that only make sense together, checked before any work. */
export function checkFlagCombinations(flags: Flags): void {
  if (flags.bool("try") && flags.bool("no-check"))
    throw usage("--try needs the key check; drop --no-check");
}

/** The provider id the command names: the first argument, else --provider. */
export function providerId(session: Session, flags: Flags): string | undefined {
  const [id] = flags.positionals;
  const flag = session.ctx.flags.provider;

  if (id && flag && id !== flag)
    throw usage(`init got two providers: ${id} and --provider ${flag}`);

  return id ?? flag;
}

async function storageFor(session: Session, flags: Flags, needed: boolean): Promise<Storage> {
  const chosen = storeFlag(flags);

  if (!needed) return chosen ?? "config";

  const keychain = await keychainAvailable(session.ctx.env);

  if (chosen === "keychain" && !keychain) throw noKeychain();

  return chosen ?? (keychain ? "keychain" : "config");
}

/** `beachside init <provider>` without questions: flags and the environment supply every answer. */
export async function initFromFlags(session: Session, flags: Flags): Promise<number> {
  readPipedKey(session, flags);
  const { out, env } = session.ctx;
  const extra = flags.positionals.slice(1);

  checkFlagCombinations(flags);
  storeFlag(flags);

  if (extra.length)
    throw usage(
      "init sets up one provider per call in the flag form",
      "repeat the command for each provider",
    );

  const target = targetFromFlags(
    session,
    flags,
    providerId(session, flags) ?? (flags.has("module") ? undefined : env.BEACHSIDE_PROVIDER),
  );

  if (!target)
    throw new CliError(
      "USAGE",
      "init needs a provider when it can't ask questions",
      `pass one of ${providers.map((provider) => provider.id).join(", ")}, e.g. \`beachside init e2b --api-key env:E2B_API_KEY\`; run it in a terminal for the guided setup`,
      { missing: ["<provider>"] },
    );

  const name = checkProfileName(flags.string("profile") ?? target.id);
  const installed = await installMissing(session, [target], out.json);
  const loaded = await session.config();
  const setup = await adapterSetup(location(target, loaded, session), session.ctx.cwd, env);
  const given = await givenValues(session, flags, setup);
  const previous = loaded.value.profiles?.[name] ?? null;
  const { draft, missing } = draftFromFlags(name, target, setup, given, previous, env);

  await keepSameKeys(session, draft);

  if (missing.length)
    throw new CliError(
      "USAGE",
      `init ${target.id} needs ${missing.join(", ")}`,
      [
        "pass the flags, or set the environment variables",
        ...Object.entries(setup?.credentials ?? {}).flatMap(([, entry]) =>
          entry.url ? [`${entry.env}: ${entry.url}`] : [],
        ),
        ...Object.entries(setup?.config ?? {}).flatMap(([, entry]) =>
          entry.required && entry.url ? [`${entry.env}: ${entry.url}`] : [],
        ),
      ].join("; "),
      { missing },
    );

  const storage = await storageFor(session, flags, Object.keys(draft.secrets).length > 0);
  const next = profileFor(draft, storage);

  const unchanged = previous !== null && !changedSettings(previous, next).length;

  if (previous && !unchanged && !flags.bool("force"))
    throw usage(
      `Profile ${name} already exists with other settings (${changedSettings(previous, next).join(", ") || "credentials"})`,
      "pass --force to replace it, or --profile <name> for a second profile",
    );

  const check = flags.bool("no-check") ? null : await checkDraft(session, draft);

  if (check?.status === "failed")
    throw new CliError(check.code, `Profile ${name} was not saved: ${check.reason}`, check.hint);

  const tried =
    flags.bool("try") && check?.status === "ok" ? await trySandbox(session, check.client) : null;

  const makeDefault = flags.bool("default") || !loaded.value.default;

  const wasDefault = loaded.value.default === name;

  if (!unchanged || (makeDefault && !wasDefault))
    await writeProfiles(session, unchanged ? [] : [draft], storage, makeDefault ? name : null);

  const result = unchanged ? "unchanged" : previous ? "updated" : "created";
  const isDefault = makeDefault || wasDefault;

  out.success(
    {
      config: loaded.path,
      profile: name,
      provider: target.official?.id ?? null,
      module: target.official ? null : target.module,
      result,
      installed,
      default: isDefault,
      credentials: credentialSources(draft, storage),
      settings: draft.config,
      check: check ? check.check : { status: "skipped" },
      try: tried,
      command: equivalentCommand(draft, storage, isDefault),
    },
    [
      `${result} profile ${name}${isDefault ? " (default)" : ""} in ${loaded.path}`,
      ...Object.entries(credentialSources(draft, storage)).map(
        ([key, source]) =>
          `  credentials.${key.padEnd(14)} ${source === "beachside.json" ? "stored in beachside.json" : source}`,
      ),
      check
        ? `key          ${check.check.status === "ok" ? "accepted" : `not checked: ${check.check.status === "unchecked" ? check.check.reason : ""}`}`
        : "key          not checked (--no-check)",
      ...(tried
        ? [
            tried.status === "ok"
              ? `try          sandbox created, ran a command and was destroyed in ${tried.seconds}s`
              : `try          failed: ${tried.reason}${tried.leftover ? `; check for sandbox ${tried.leftover}` : ""}`,
          ]
        : []),
      ...(isDefault
        ? ["next: beachside create --name web"]
        : [`next: beachside create --name web --profile ${name}`]),
    ].join("\n"),
  );

  return tried?.status === "failed" ? 1 : 0;
}

/** `beachside init`: the guided setup in a terminal, the flag form everywhere else. */
export async function initCommand(session: Session, flags: Flags): Promise<number> {
  if (!interactive(session, flags)) return initFromFlags(session, flags);

  // The prompt library is loaded only here, after deciding a person is at a terminal. It is a
  // devDependency on purpose: the build bundles it into dist, so installs don't fetch it.
  const { clackPrompter } = await import("./init-prompts");

  return runWizard(session, flags, clackPrompter(session.ctx.signal));
}
