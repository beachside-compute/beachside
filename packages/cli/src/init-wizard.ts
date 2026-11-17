import { z } from "zod";
import { checkCredentials, type Flags } from "./commands";
import type { ProfileConfig } from "./config";
import {
  adapterInstalled,
  checkDraft,
  checkFlagCombinations,
  checkProfileName,
  chosenGroup,
  credentialKeys,
  equivalentCommand,
  givenValues,
  installMissing,
  isReference,
  keepSameKeys,
  location,
  newKeychainId,
  noKeychain,
  officialTarget,
  providerId,
  sameAdapter,
  storeFlag,
  targetFromFlags,
  trySandbox,
  writeProfiles,
  type CheckResult,
  type Draft,
  type Given,
  type InitTarget,
  type Storage,
  type TryResult,
} from "./init";
import { describeError, exitCodeFor, usage } from "./output";
import { updateConfig } from "./profiles";
import { adapterSetup, providers, resolveProfile } from "./providers";
import { keychainAvailable } from "./secrets";
import type { Session } from "./session";

/** The person pressed Ctrl-C or Escape at a question. */
export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "PromptCancelled";
  }
}

export type Choice = { value: string; label?: string; hint?: string };

/**
 * The questions the wizard asks. The steps are plain code over these answers, so tests drive
 * every step without a terminal and the flag form shares the same building blocks.
 */
export type Prompter = {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  step(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  select(options: { message: string; options: Choice[]; initial?: string }): Promise<string>;
  multiselect(options: {
    message: string;
    options: Choice[];
    initial?: string[];
  }): Promise<string[]>;
  confirm(options: { message: string; initial?: boolean }): Promise<boolean>;
  text(options: {
    message: string;
    placeholder?: string;
    initial?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  password(options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  /** Show a spinner while `work` runs, then the line `done` makes from its result. */
  spin<T>(message: string, work: () => Promise<T>, done: (value: T) => string): Promise<T>;
};

const required = (value: string) => (value.trim() ? undefined : "This is required");

/** "apiKey" -> "API key", "tokenSecret" -> "token secret". */
function keyLabel(key: string): string {
  if (key === "apiKey") return "API key";

  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Ask for one credential: reuse the environment or the old profile, else a hidden paste. */
async function askCredential(
  prompt: Prompter,
  draft: Draft,
  key: string,
  env: Session["ctx"]["env"],
): Promise<void> {
  const entry = draft.setup?.credentials[key];
  const label = `${draft.target.label} ${keyLabel(key)}`;

  if (entry?.env && env[entry.env]) {
    if (
      await prompt.confirm({ message: `Use ${entry.env} from your environment?`, initial: true })
    ) {
      draft.credentials[key] = `env:${entry.env}`;
      delete draft.secrets[key];

      return;
    }
  }

  const current = draft.credentials[key];

  if (current !== undefined) {
    const where = isReference(current) ? current : "stored in beachside.json";

    if (await prompt.confirm({ message: `Keep the current ${label} (${where})?`, initial: true })) {
      draft.credentials[key] = current;
      delete draft.secrets[key];

      return;
    }
  }

  if (entry?.url) prompt.info(`Get your ${label} at ${entry.url}`);
  else if (entry?.description) prompt.info(entry.description);

  const value = (
    await prompt.password({
      message: `Paste your ${label} (or an env:NAME, op:// or keychain:// reference)`,
      validate: required,
    })
  ).trim();

  setCredential(draft, key, value);
}

/** Put one credential where it belongs, replacing whatever the draft held for it. */
function setCredential(draft: Draft, key: string, value: string): void {
  delete draft.credentials[key];
  delete draft.secrets[key];

  if (isReference(value)) draft.credentials[key] = value;
  else draft.secrets[key] = value;
}

/** Ask for the settings the adapter needs, and the ones it offers a choice for. */
async function askConfig(
  prompt: Prompter,
  draft: Draft,
  given: Given,
  env: Session["ctx"]["env"],
): Promise<void> {
  const setup = draft.setup!;

  for (const [key, entry] of Object.entries(setup.config ?? {})) {
    if (given.config[key] !== undefined) continue;
    const fromEnv = env[entry.env];
    const current = z.string().safeParse(draft.config[key]);
    const text = current.success ? current.data : undefined;

    if (entry.required) {
      if (
        fromEnv &&
        (await prompt.confirm({
          message: `Use ${entry.env}=${fromEnv} from your environment?`,
          initial: true,
        }))
      ) {
        draft.config[key] = fromEnv;
        continue;
      }

      if (entry.description) prompt.info(entry.description + (entry.url ? ` (${entry.url})` : ""));

      draft.config[key] = entry.choices?.length
        ? await prompt.select({
            message: `${draft.target.label} ${keyLabel(key)}`,
            options: entry.choices.map((choice) => ({ value: choice })),
            initial: text && entry.choices.includes(text) ? text : entry.choices[0],
          })
        : (
            await prompt.text({
              message: `${draft.target.label} ${keyLabel(key)}`,
              initial: text,
              validate: required,
            })
          ).trim();

      continue;
    }

    // Optional settings are asked only when the adapter offers a short list of choices.
    if (!entry.choices?.length) continue;

    const picked = await prompt.select({
      message: `${draft.target.label} ${keyLabel(key)}`,
      options: [
        { value: "", label: "provider default", hint: entry.description },
        ...entry.choices.map((choice) => ({ value: choice })),
      ],
      initial: text ?? fromEnv ?? "",
    });

    if (picked) draft.config[key] = picked;
    else delete draft.config[key];
  }
}

/** A new name for a second profile on the same provider, such as boxd-2. */
function freeName(base: string, taken: Set<string>): string {
  for (let index = 2; ; index++) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
}

/** One provider's section: its profile name, keys and settings. Null when the person skips it. */
async function draftFor(
  prompt: Prompter,
  session: Session,
  target: InitTarget,
  given: Given,
  nameFlag: string | undefined,
  taken: Set<string>,
  force: boolean,
): Promise<Draft | null> {
  const { env, cwd } = session.ctx;
  const loaded = await session.config();
  let name = nameFlag ?? target.id;
  const existing = loaded.value.profiles ?? {};
  const other = existing[name] ? !sameAdapter(existing[name]!, target) : false;

  if (existing[name] && !force) {
    const what = other
      ? `a ${existing[name]!.provider ?? existing[name]!.module} profile`
      : "keeps what you don't change";

    const choice = await prompt.select({
      message: `There is already a profile named ${name}`,
      options: [
        {
          value: "replace",
          label: other ? `Replace ${name} with a ${target.label} profile` : `Change ${name}`,
          hint: what,
        },
        { value: "new", label: "Add a second profile", hint: "another account or region" },
        { value: "skip", label: `Leave ${name} as it is` },
      ],
      initial: other ? "new" : "replace",
    });

    if (choice === "skip") return null;

    if (choice === "new")
      name = (
        await prompt.text({
          message: "Name for the new profile",
          initial: freeName(name, new Set([...Object.keys(existing), ...taken])),
          validate: (value) => {
            try {
              checkProfileName(value.trim());
            } catch {
              return "Use letters, digits, dot, dash or underscore";
            }

            return existing[value.trim()] || taken.has(value.trim())
              ? "That name is taken"
              : undefined;
          },
        })
      ).trim();
  }

  const previous: ProfileConfig | null = existing[name] ?? null;
  // A profile for another adapter is replaced, not merged: its keys and settings don't apply.
  const kept = previous && sameAdapter(previous, target) ? previous : null;
  const setup = await adapterSetup(location(target, loaded, session), cwd, env);

  const draft: Draft = {
    name,
    target,
    setup,
    // Changing a profile keeps what the questions below don't replace.
    credentials: { ...kept?.credentials },
    secrets: {},
    config: { ...setup?.defaults, ...kept?.config },
    previous,
    keychainId: newKeychainId(),
  };

  for (const [key, value] of Object.entries(given.credentials)) setCredential(draft, key, value);

  Object.assign(draft.config, given.config);

  if (!setup) {
    prompt.warn(
      `${target.label}'s adapter declares no setup, so beachside can't ask for its settings; the profile keeps what you passed and you can add the rest in beachside.json`,
    );

    return draft;
  }

  let group = chosenGroup(
    setup,
    (key) =>
      given.credentials[key] !== undefined ||
      Boolean(setup.credentials[key] && env[setup.credentials[key]!.env]),
  );

  if ((setup.alternatives?.length ?? 0) > 1 && !Object.keys(given.credentials).length) {
    const options = setup.alternatives!.map((keys, index) => ({
      value: String(index),
      label: keys.map((key) => setup.credentials[key]?.env ?? keyLabel(key)).join(" and "),
    }));

    group =
      setup.alternatives![
        Number(
          await prompt.select({
            message: `How should beachside sign in to ${target.label}?`,
            options,
            initial: String(setup.alternatives!.indexOf(group!)),
          }),
        )
      ]!;
  }

  for (const key of credentialKeys(setup, group))
    if (given.credentials[key] === undefined) await askCredential(prompt, draft, key, env);

  await askConfig(prompt, draft, given, env);

  return draft;
}

/** One line per provider: what was found for it before anything is installed or asked. */
function found(
  provider: (typeof providers)[number],
  env: Session["ctx"]["env"],
  profiles: string[],
): string | undefined {
  const parts = [
    ...(env[provider.keyEnv] ? [`found ${provider.keyEnv}`] : []),
    ...(profiles.length ? [`profile ${profiles.join(", ")}`] : []),
    ...(provider.experimental ? ["experimental"] : []),
  ];

  return [provider.summary, ...parts].join(" · ");
}

async function pickTargets(prompt: Prompter, session: Session): Promise<InitTarget[]> {
  const loaded = await session.config();
  const configured = Object.entries(loaded.value.profiles ?? {});

  const picked = await prompt.multiselect({
    message: "Which providers do you want to use? (space to pick, enter when done)",
    options: providers.map((provider) => ({
      value: provider.id,
      label: officialTarget(provider).label,
      hint: found(
        provider,
        session.ctx.env,
        configured.filter(([, profile]) => profile.provider === provider.id).map(([name]) => name),
      ),
    })),
    // A key found in the environment pre-ticks the provider, unless a profile already covers it.
    initial: providers
      .filter(
        (provider) =>
          session.ctx.env.BEACHSIDE_PROVIDER === provider.id ||
          (session.ctx.env[provider.keyEnv] &&
            !configured.some(([, profile]) => profile.provider === provider.id)),
      )
      .map((provider) => provider.id),
  });

  return providers.filter((provider) => picked.includes(provider.id)).map(officialTarget);
}

/** Check every configured profile, as `doctor` would, one line each. */
async function checkAll(prompt: Prompter, session: Session): Promise<number> {
  const loaded = await session.config();
  const names = Object.keys(loaded.value.profiles ?? {});

  const results = await prompt.spin(
    `Checking ${names.length} profile(s)`,
    () =>
      Promise.all(
        names.map(async (name) => {
          try {
            const profile = await resolveProfile(
              { profile: name },
              loaded,
              session.ctx.env,
              session.ctx.cwd,
            );

            const check = await checkCredentials(await session.connect(profile));

            return check.status === "ok" || check.status === "unchecked"
              ? { name, ok: true, reason: "", code: "" }
              : { name, ok: false, reason: check.reason, code: check.code };
          } catch (cause) {
            const report = describeError(cause);

            return { name, ok: false, reason: report.message, code: report.code };
          }
        }),
      ),
    (all) => `Checked ${all.length} profile(s)`,
  );

  for (const result of results)
    if (result.ok)
      prompt.success(`${result.name}${loaded.value.default === result.name ? " (default)" : ""}`);
    else prompt.error(`${result.name}: ${result.reason}`);

  prompt.outro(
    results.every((result) => result.ok)
      ? "Every profile works"
      : "Fix the profiles above, then run `beachside init` again",
  );

  const failed = results.find((result) => !result.ok);

  return failed ? exitCodeFor(failed.code) : 0;
}

async function changeDefault(prompt: Prompter, session: Session): Promise<number> {
  const loaded = await session.config();
  const names = Object.keys(loaded.value.profiles ?? {});

  const picked = await prompt.select({
    message: "Which profile should be the default?",
    options: names.map((name) => ({ value: name, hint: loaded.value.profiles?.[name]?.provider })),
    initial: loaded.value.default ?? names[0],
  });

  await updateConfig(loaded.path, (raw) =>
    raw.default === picked ? null : { ...raw, default: picked },
  );
  prompt.outro(`${picked} is the default profile`);

  return 0;
}

/** The guided `beachside init`: pick providers, answer each one's questions, check, save. */
export async function runWizard(session: Session, flags: Flags, prompt: Prompter): Promise<number> {
  try {
    return await wizard(session, flags, prompt);
  } catch (cause) {
    if (cause instanceof PromptCancelled || session.ctx.signal.aborted) {
      prompt.cancel("Cancelled; nothing was saved");

      return 130;
    }

    throw cause;
  }
}

async function wizard(session: Session, flags: Flags, prompt: Prompter): Promise<number> {
  const { env } = session.ctx;
  const loaded = await session.config();
  const existing = Object.keys(loaded.value.profiles ?? {});

  // Flags are checked before the first question, so a mistake doesn't cost a run of answers.
  checkFlagCombinations(flags);
  const store = storeFlag(flags);

  if (store === "keychain" && !(await keychainAvailable(env))) throw noKeychain();
  const nameFlag = flags.string("profile");

  if (nameFlag !== undefined) checkProfileName(nameFlag);

  prompt.intro("beachside init");

  const named = targetFromFlags(session, flags, providerId(flags));

  // `-` reads a piped key, but in a terminal stdin is the keyboard the questions use.
  if (
    flags.string("api-key") === "-" ||
    flags.strings("credential").some((pair) => pair.endsWith("=-"))
  )
    throw usage(
      "A credential given as - is read from a pipe, not in the guided setup",
      "leave it out to paste it when asked, or pipe the key into the command with --no-input",
    );

  if (flags.positionals.length > 1)
    prompt.warn(
      "The guided setup takes one provider on the command line; pick the rest from the list",
    );

  if (!named && existing.length) {
    const action = await prompt.select({
      message: `You have ${existing.length} profile(s) (default: ${loaded.value.default ?? "none"}). What would you like to do?`,
      options: [
        { value: "add", label: "Add or change providers" },
        ...(existing.length > 1 ? [{ value: "default", label: "Change the default profile" }] : []),
        { value: "check", label: "Check every profile" },
        { value: "exit", label: "Nothing, exit" },
      ],
      initial: "add",
    });

    if (action === "exit") {
      prompt.outro("Nothing changed");

      return 0;
    }

    if (action === "check") return checkAll(prompt, session);

    if (action === "default") return changeDefault(prompt, session);
  }

  const targets = named ? [named] : await pickTargets(prompt, session);

  // Adapters that are missing are installed together, before any question about them.
  const missing: InitTarget[] = [];

  for (const target of targets)
    if (target.official && !(await adapterInstalled(target, loaded, session))) missing.push(target);

  let usable = targets;

  if (missing.length)
    try {
      await prompt.spin(
        `Installing adapters: ${missing.map((target) => target.id).join(", ")}`,
        () => installMissing(session, missing, true),
        (installed) => `Installed ${installed.join(", ")}`,
      );
    } catch (cause) {
      const report = describeError(cause);
      prompt.error(
        `Could not install ${missing.map((target) => target.id).join(", ")}: ${report.message}`,
      );

      if (report.hint) prompt.info(report.hint);
      usable = targets.filter((target) => !missing.includes(target));
    }

  if (!usable.length) {
    prompt.outro("Nothing was set up");

    return 1;
  }

  // Flags fill answers when one provider is named, so a half-scripted run asks only the rest.
  const drafts: Draft[] = [];
  const taken = new Set<string>();

  for (const [index, target] of usable.entries()) {
    prompt.step(`${target.label}${usable.length > 1 ? ` (${index + 1} of ${usable.length})` : ""}`);

    const setup = named
      ? await adapterSetup(location(target, loaded, session), session.ctx.cwd, env)
      : null;

    const given = named
      ? await givenValues(session, flags, setup)
      : { credentials: {}, config: {} };

    const draft = await draftFor(
      prompt,
      session,
      target,
      given,
      named ? nameFlag : undefined,
      taken,
      flags.bool("force"),
    );

    if (draft) {
      await keepSameKeys(session, draft);
      drafts.push(draft);
      taken.add(draft.name);
    }
  }

  if (!drafts.length) {
    prompt.outro("Nothing changed");

    return 0;
  }

  const storage = askStorage(prompt, flags, drafts);
  const defaultName = await askDefault(prompt, session, flags, drafts);

  // --no-check saves every profile unchecked, as the flag form does.
  const checks = flags.bool("no-check")
    ? null
    : await prompt.spin(
        "Checking keys",
        () => Promise.all(drafts.map((draft) => checkDraft(session, draft))),
        (results) =>
          results
            .map(
              (result, index) =>
                `${result.status === "ok" ? "✓" : "✗"} ${drafts[index]!.target.label}`,
            )
            .join("  "),
      );

  const passed = checks ? drafts.filter((_, index) => checks[index]!.status === "ok") : drafts;

  for (const [index, check] of (checks ?? []).entries())
    if (check.status === "failed") {
      prompt.error(`${drafts[index]!.name} was not saved: ${check.reason}`);

      if (check.hint) prompt.info(check.hint);
    }

  if (!passed.length) {
    prompt.outro("Nothing was saved; fix the keys above and run `beachside init` again");
    const failure = (checks ?? []).find((check) => check.status === "failed");

    return failure?.status === "failed" ? exitCodeFor(failure.code) : 1;
  }

  const tries =
    checks &&
    (flags.bool("try") ||
      (await prompt.confirm({
        message: `Try a sandbox on ${passed.length > 1 ? "each" : passed[0]!.target.label} now? It takes a few seconds and is deleted after.`,
        initial: true,
      })))
      ? await prompt.spin(
          "Creating test sandboxes",
          () => tryEach(session, checks),
          (results) =>
            results
              .map(
                (result, index) =>
                  `${result.status === "ok" ? "✓" : "✗"} ${passed[index]!.target.label}${result.status === "ok" ? ` ${result.seconds}s` : ""}`,
              )
              .join("  "),
        )
      : null;

  for (const [index, result] of (tries ?? []).entries())
    if (result.status === "failed")
      prompt.warn(
        `${passed[index]!.target.label}: the key works but a test sandbox failed: ${result.reason}${result.leftover ? ` (check for sandbox ${result.leftover})` : ""}`,
      );

  // The default must be a profile that is saved.
  const savedDefault =
    defaultName && passed.some((draft) => draft.name === defaultName)
      ? defaultName
      : !loaded.value.default
        ? passed[0]!.name
        : null;

  await writeProfiles(session, passed, storage, savedDefault);

  const finalDefault = savedDefault ?? loaded.value.default ?? null;

  prompt.success(
    `Saved ${passed.map((draft) => `${draft.name}${draft.name === finalDefault ? " (default)" : ""}`).join(", ")} in ${loaded.path}`,
  );

  prompt.note(
    passed
      .map((draft) => equivalentCommand(draft, storage, draft.name === finalDefault))
      .join("\n"),
    "To repeat this without questions",
  );

  prompt.outro(
    [
      "Next:",
      ...passed.map((draft) =>
        draft.name === finalDefault
          ? `  beachside create --name web`
          : `  beachside create --name web --profile ${draft.name}`,
      ),
      "  beachside skill setup     teach your coding agent beachside",
    ].join("\n"),
  );

  const failed = (tries ?? []).some((result: TryResult) => result.status === "failed");

  return passed.length < drafts.length || failed ? 1 : 0;
}

/**
 * Try a sandbox on every checked provider. Each one finishes, destroying its sandbox, before an
 * interruption ends the run, so Ctrl-C never leaves a test sandbox behind unreported.
 */
async function tryEach(session: Session, checks: CheckResult[]): Promise<TryResult[]> {
  const settled = await Promise.allSettled(
    checks.flatMap((check) => (check.status === "ok" ? [trySandbox(session, check.client)] : [])),
  );

  const failed = settled.find((result) => result.status === "rejected");

  if (failed) throw failed.reason;

  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

/** New keys go in beachside.json (mode 0600) unless --store keychain asks for the OS keychain. */
function askStorage(prompt: Prompter, flags: Flags, drafts: Draft[]): Storage {
  const chosen = storeFlag(flags);

  if (chosen) return chosen;

  if (drafts.some((draft) => Object.keys(draft.secrets).length))
    prompt.info(
      "New keys go in beachside.json (readable only by you); pass --store keychain to keep them in the OS keychain",
    );

  return "config";
}

async function askDefault(
  prompt: Prompter,
  session: Session,
  flags: Flags,
  drafts: Draft[],
): Promise<string | null> {
  const loaded = await session.config();
  const current = loaded.value.default;

  if (flags.bool("default")) return drafts[0]!.name;

  if (drafts.length === 1 && !current) return drafts[0]!.name;

  if (drafts.length === 1 && current === drafts[0]!.name) return null;

  const picked = await prompt.select({
    message: "Which one should be the default?",
    options: [
      ...(current && !drafts.some((draft) => draft.name === current)
        ? [{ value: "", label: `keep ${current}` }]
        : []),
      ...drafts.map((draft) => ({ value: draft.name, hint: draft.target.label })),
    ],
    initial:
      current && drafts.some((draft) => draft.name === current)
        ? current
        : current
          ? ""
          : drafts[0]!.name,
  });

  return picked || null;
}
