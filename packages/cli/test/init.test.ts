import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@beachside/adapter";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { Flags } from "../src/commands";
import {
  equivalentCommand,
  givenValues,
  newKeychainId,
  officialTarget,
  providerId,
  writeProfiles,
  type Draft,
} from "../src/init";
import { descriptor } from "../src/providers";
import { PromptCancelled, runWizard, type Choice, type Prompter } from "../src/init-wizard";
import { Output } from "../src/output";
import { Session } from "../src/session";

const token = "init-test-token-12345";

const main = join(import.meta.dir, "..", "src", "main.ts");

const fixture = join(import.meta.dir, "init-adapter.ts");

let root: string;

let server: Awaited<ReturnType<typeof startFakeProviderServer>>;

let dir: string;

let saved = { url: process.env.BEACHSIDE_FAKE_URL, token: process.env.BEACHSIDE_FAKE_TOKEN };

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "beachside-init-")));
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(root, "fake.json"),
    token,
    testMode: true,
  });
  // The wizard tests load the fixture in this process.
  saved = { url: process.env.BEACHSIDE_FAKE_URL, token: process.env.BEACHSIDE_FAKE_TOKEN };
  process.env.BEACHSIDE_FAKE_URL = server.url.toString();
  process.env.BEACHSIDE_FAKE_TOKEN = token;
});

afterAll(async () => {
  // Other test files in this process point the fixture at their own fake server.
  if (saved.url === undefined) delete process.env.BEACHSIDE_FAKE_URL;
  else process.env.BEACHSIDE_FAKE_URL = saved.url;

  if (saved.token === undefined) delete process.env.BEACHSIDE_FAKE_TOKEN;
  else process.env.BEACHSIDE_FAKE_TOKEN = saved.token;

  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

async function control(path: string, body: Json) {
  const response = await fetch(new URL(path, server.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  expect(response.ok).toBe(true);
}

/** The test sandbox runs `echo beachside`; the fake answers only seeded commands. */
async function seedTryCommand() {
  await control("/_test/seed", {
    submissionId: "*",
    action: "exec",
    command: {
      command: { kind: "argv", argv: ["echo", "beachside"] },
      exitCode: 0,
      stdoutBase64: Buffer.from("beachside\n").toString("base64"),
      stderrBase64: "",
    },
  });
}

beforeEach(async () => {
  await control("/_test/reset", {});
  dir = await mkdtemp(join(root, "case-"));
});

const configPath = () => join(dir, "beachside", "beachside.json");

async function config() {
  return JSON.parse(await readFile(configPath(), "utf8"));
}

function baseEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    XDG_CONFIG_HOME: dir,
    BEACHSIDE_TELEMETRY: "0",
    BEACHSIDE_FAKE_URL: server.url.toString(),
    BEACHSIDE_FAKE_TOKEN: token,
    ...extra,
  };
}

async function cli(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const child = Bun.spawn(["bun", main, ...args], {
    cwd: dir,
    env: baseEnv(env),
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

const fake = ["init", "--module", fixture, "--export", "initable", "--profile", "fk"];

test("the flag form writes a profile from flags and the environment, without printing the key", async () => {
  const result = await cli([...fake, "--set", "region=north", "--json"], { FAKE_TOKEN: token });

  expect(result).toMatchObject({ code: 0 });
  expect(result.stdout).not.toContain(token);

  const { data } = JSON.parse(result.stdout);

  expect(data).toMatchObject({
    profile: "fk",
    result: "created",
    default: true,
    credentials: { token: "env:FAKE_TOKEN" },
    settings: { region: "north", environment: { kind: "prepared", value: "fake-starter" } },
    check: { status: "ok" },
  });
  expect(data.command).toContain("--credential token=env:FAKE_TOKEN");
  expect(data.command).toContain("--set region=north");
  // The adapter's own default isn't repeated in the command.
  expect(data.command).not.toContain("environment");

  expect(await config()).toEqual({
    $schema: "https://beachside.run/schema/beachside.json",
    default: "fk",
    profiles: {
      fk: {
        module: fixture,
        export: "initable",
        config: { environment: { kind: "prepared", value: "fake-starter" }, region: "north" },
        credentials: { token: "env:FAKE_TOKEN" },
      },
    },
  });

  // The saved profile works for every other command.
  const doctor = await cli(["doctor", "--json"], { FAKE_TOKEN: token });

  expect(JSON.parse(doctor.stdout).data.credentials).toEqual({ status: "ok" });
});

test("a missing answer exits 2 with the flags it needs and writes nothing", async () => {
  const result = await cli([...fake, "--json"]);

  expect(result.code).toBe(2);

  const { error } = JSON.parse(result.stdout);

  expect(error.known.missing).toEqual([
    "--credential token=... (or FAKE_TOKEN)",
    "--set region=<north|south> (or FAKE_REGION)",
  ]);
  expect(error.hint).toContain("FAKE_TOKEN: https://fake.example/keys");
  await expect(stat(configPath())).rejects.toThrow();
});

test("without a terminal init never asks, and needs a provider", async () => {
  const result = await cli(["init", "--json"]);

  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error.known.missing).toEqual(["<provider>"]);
});

test("a rejected key is not saved; a piped key is stored in beachside.json at 0600", async () => {
  const wrong = await cli(
    [...fake, "--api-key", "-", "--set", "region=south", "--store", "config", "--json"],
    {},
    "not-the-token\n",
  );

  expect(wrong).toMatchObject({ code: 5 });
  expect(JSON.parse(wrong.stdout).error.message).toContain("Profile fk was not saved");
  await expect(stat(configPath())).rejects.toThrow();

  const right = await cli(
    [...fake, "--api-key", "-", "--set", "region=south", "--store", "config", "--json"],
    {},
    `${token}\n`,
  );

  expect(right.code).toBe(0);
  expect(right.stdout).not.toContain(token);

  const { data } = JSON.parse(right.stdout);

  expect(data.credentials).toEqual({ token: "beachside.json" });
  // The command to repeat it reads the key from stdin rather than printing it.
  expect(data.command).toContain("--credential token=-");
  expect((await config()).profiles.fk.credentials).toEqual({ token });
  expect((await stat(configPath())).mode & 0o777).toBe(0o600);
});

test("rerunning with the same piped key, or the printed command, reports unchanged", async () => {
  const first = await cli(
    [...fake, "--api-key", "-", "--set", "region=north", "--store", "config", "--json"],
    {},
    `${token}\n`,
  );

  expect(first).toMatchObject({ code: 0 });
  const { command } = JSON.parse(first.stdout).data;

  const again = await cli(
    [...fake, "--api-key", "-", "--set", "region=north", "--store", "config", "--json"],
    {},
    `${token}\n`,
  );

  expect(JSON.parse(again.stdout).data.result).toBe("unchanged");

  // The repeat command runs as printed (no word in it needs shell quoting here).
  const words = String(command).split(" ");

  expect(words.slice(0, 2)).toEqual(["beachside", "init"]);

  const replay = await cli([...words.slice(1), "--json"], {}, `${token}\n`);

  expect(replay).toMatchObject({ code: 0 });
  expect(JSON.parse(replay.stdout).data.result).toBe("unchanged");
});

test("rerunning is safe: unchanged is fine, a change needs --force", async () => {
  const first = await cli([...fake, "--set", "region=north"], { FAKE_TOKEN: token });

  expect(first.code).toBe(0);

  const again = await cli([...fake, "--set", "region=north", "--json"], { FAKE_TOKEN: token });

  expect(JSON.parse(again.stdout).data.result).toBe("unchanged");

  const changed = await cli([...fake, "--set", "region=south", "--json"], { FAKE_TOKEN: token });

  expect(changed.code).toBe(2);
  expect(JSON.parse(changed.stdout).error.message).toContain("config.region");

  const forced = await cli([...fake, "--set", "region=south", "--force", "--json"], {
    FAKE_TOKEN: token,
  });

  expect(JSON.parse(forced.stdout).data.result).toBe("updated");
  expect((await config()).profiles.fk.config.region).toBe("south");
});

test("a second profile is not made the default unless asked", async () => {
  await cli([...fake, "--set", "region=north"], { FAKE_TOKEN: token });

  const second = await cli(
    [
      "init",
      "--module",
      fixture,
      "--export",
      "initable",
      "--profile",
      "fk2",
      "--set",
      "region=south",
    ],
    { FAKE_TOKEN: token },
  );

  expect(second.code).toBe(0);
  expect(second.stdout).toContain("--profile fk2");
  expect((await config()).default).toBe("fk");

  await cli(
    [
      "init",
      "--module",
      fixture,
      "--export",
      "initable",
      "--profile",
      "fk2",
      "--set",
      "region=south",
      "--default",
    ],
    { FAKE_TOKEN: token },
  );

  expect((await config()).default).toBe("fk2");
});

test("--try creates a sandbox, runs a command and destroys it", async () => {
  await seedTryCommand();

  const result = await cli([...fake, "--set", "region=north", "--try", "--json"], {
    FAKE_TOKEN: token,
  });

  expect(result).toMatchObject({ code: 0 });
  expect(JSON.parse(result.stdout).data.try).toMatchObject({ status: "ok" });

  const response = await fetch(new URL("/_test/state", server.url), {
    headers: { Authorization: `Bearer ${token}` },
  });

  const { resources } = await response.json();

  expect(resources.length).toBeGreaterThan(0);
  expect(resources.every((resource: { state: string }) => resource.state === "destroyed")).toBe(
    true,
  );
});

/** A fake secret-tool that keeps items in a folder, to prove keys go to it on stdin. */
/** A secret-tool that keeps items as files; `slowStore` makes a store hang after writing. */
async function fakeSecretTool(slowStore = false): Promise<string> {
  const bin = join(dir, "bin");
  const store = join(dir, "keyring");
  await mkdir(bin, { recursive: true });
  await mkdir(store, { recursive: true });
  await writeFile(
    join(bin, "secret-tool"),
    `#!/bin/sh
set -e
case "$1" in
  store) shift; while [ "$1" != "account" ]; do shift; done; cat > "${store}/$2"${slowStore ? "; sleep 5" : ""} ;;
  lookup) shift; while [ "$1" != "account" ]; do shift; done; cat "${store}/$2" ;;
  clear) shift; while [ "$1" != "account" ]; do shift; done; rm "${store}/$2" ;;
  *) exit 1 ;;
esac
`,
  );
  await chmod(join(bin, "secret-tool"), 0o755);

  return bin;
}

test.skipIf(process.platform === "darwin")(
  "with --store keychain, a pasted key goes to the OS keychain and the profile keeps only a reference",
  async () => {
    const bin = await fakeSecretTool();
    const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

    const result = await cli(
      [...fake, "--api-key", "-", "--set", "region=north", "--store", "keychain", "--json"],
      env,
      token,
    );

    expect(result).toMatchObject({ code: 0 });

    const reference = JSON.parse(result.stdout).data.credentials.token;

    expect(reference).toMatch(/^keychain:\/\/beachside\/fk\.token\.[0-9a-f]{8}$/);

    const account = reference.slice("keychain://beachside/".length);

    expect(await readdir(join(dir, "keyring"))).toEqual([account]);
    expect(await readFile(join(dir, "keyring", account), "utf8")).toBe(token);
    expect(JSON.stringify(await config())).not.toContain(token);

    // Every command reads it back from the keychain.
    const doctor = await cli(["doctor", "--json"], env);

    expect(JSON.parse(doctor.stdout).data.credentials).toEqual({ status: "ok" });

    const show = await cli(["profile", "show", "fk", "--json"], env);

    expect(JSON.parse(show.stdout).data.credentials.token).toMatchObject({
      from: "secret-manager",
      reference,
    });

    // Piping the same key again keeps the item it is already in.
    const again = await cli(
      [...fake, "--api-key", "-", "--set", "region=north", "--store", "keychain", "--json"],
      env,
      token,
    );

    expect(JSON.parse(again.stdout).data).toMatchObject({
      result: "unchanged",
      credentials: { token: reference },
    });

    // A different key (the item now holds an older one) is stored under a new name, and the old
    // item is removed only once the profile is saved.
    await writeFile(join(dir, "keyring", account), "an-older-key");

    const replaced = await cli(
      [
        ...fake,
        "--api-key",
        "-",
        "--set",
        "region=north",
        "--store",
        "keychain",
        "--force",
        "--json",
      ],
      env,
      token,
    );

    const next = JSON.parse(replaced.stdout).data.credentials.token;

    expect(next).not.toBe(reference);
    expect(await readdir(join(dir, "keyring"))).toEqual([
      next.slice("keychain://beachside/".length),
    ]);

    // A rejected key leaves the keychain and the profile as they were.
    const rejected = await cli(
      [
        ...fake,
        "--api-key",
        "-",
        "--set",
        "region=north",
        "--store",
        "keychain",
        "--force",
        "--json",
      ],
      env,
      "wrong",
    );

    expect(rejected.code).toBe(5);
    expect(await readdir(join(dir, "keyring"))).toHaveLength(1);
    expect((await config()).profiles.fk.credentials.token).toBe(next);
  },
);

test("a pasted key goes to beachside.json by default, even when a keychain is available", async () => {
  // macOS always has `security`; elsewhere a fake secret-tool makes a keychain available.
  const bin = await fakeSecretTool();
  const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };

  const result = await cli(
    [...fake, "--api-key", "-", "--set", "region=north", "--json"],
    env,
    token,
  );

  expect(result).toMatchObject({ code: 0 });
  expect((await config()).profiles.fk.credentials.token).toBe(token);
  expect(await readdir(join(dir, "keyring")).catch(() => [])).toEqual([]);
});

test("a key kept in an existing beachside.json makes the file readable only by you", async () => {
  await mkdir(join(dir, "beachside"), { recursive: true });
  await writeFile(configPath(), JSON.stringify({ profiles: {} }), { mode: 0o644 });
  await chmod(configPath(), 0o644);

  const result = await cli(
    [...fake, "--api-key", "-", "--set", "region=north", "--store", "config"],
    {},
    token,
  );

  expect(result).toMatchObject({ code: 0 });
  expect((await stat(configPath())).mode & 0o777).toBe(0o600);
});

/** Answers each question from a script keyed by part of its message, and records what it saw. */
function scripted(answers: [RegExp, string | string[] | boolean | "cancel"][]) {
  const asked: string[] = [];
  const said: string[] = [];

  const next = (message: string) => {
    asked.push(message);
    const index = answers.findIndex(([pattern]) => pattern.test(message));

    if (index === -1) throw new Error(`unexpected question: ${message}`);
    const [, value] = answers.splice(index, 1)[0]!;

    if (value === "cancel") throw new PromptCancelled();

    return value;
  };

  const log = (message: string) => {
    said.push(message);
  };

  const prompt: Prompter = {
    intro: log,
    outro: log,
    cancel: log,
    note: log,
    info: log,
    step: log,
    success: log,
    warn: log,
    error: log,
    select: async (options: { message: string; options: Choice[] }) => {
      const value = String(next(options.message));

      if (!options.options.some((option) => option.value === value))
        throw new Error(`${value} is not a choice for ${options.message}`);

      return value;
    },
    multiselect: async (options) => {
      const value = next(options.message);

      return Array.isArray(value) ? value : [String(value)];
    },
    confirm: async (options) => next(options.message) === true,
    text: async (options) => String(next(options.message)),
    password: async (options) => String(next(options.message)),
    spin: async (_message, work, done) => {
      const value = await work();
      said.push(done(value));

      return value;
    },
  };

  return { prompt, asked, said };
}

function session(env: Record<string, string> = {}) {
  const lines: string[] = [];

  return new Session({
    // Only tests that install a fixture keychain tool should detect an OS keychain.
    env: baseEnv({ PATH: dir, ...env }),
    cwd: dir,
    out: new Output(false, {
      stdout: (text) => lines.push(String(text)),
      stderr: (text) => lines.push(String(text)),
    }),
    flags: { json: false, profile: "fk" },
    signal: new AbortController().signal,
    stdin: async function* () {},
    terminal: true,
    createsConfig: true,
  });
}

const wizardFlags = (values: Record<string, string | boolean> = {}) =>
  new Flags({ module: fixture, export: "initable", profile: "fk", ...values }, [], null);

test("the wizard asks for the key and settings, checks, tries a sandbox and saves", async () => {
  await seedTryCommand();

  const { prompt, asked, said } = scripted([
    [/Paste your fk token/, token],
    [/fk region/, "south"],
    [/fk network/, "internet"],
    [/Try a sandbox/, true],
  ]);

  const run = session();
  const code = await runWizard(run, wizardFlags(), prompt);
  await run.close();

  expect(code).toBe(0);
  expect(asked).toHaveLength(4);
  // New keys go in beachside.json without asking, and the person is told how to opt in.
  expect(said.some((line) => line.includes("New keys go in beachside.json"))).toBe(true);
  expect(said).toContain("Get your fk token at https://fake.example/keys");
  expect(said.join("\n")).not.toContain(token);

  expect((await config()).profiles.fk).toEqual({
    module: fixture,
    export: "initable",
    config: {
      environment: { kind: "prepared", value: "fake-starter" },
      region: "south",
      network: "internet",
    },
    credentials: { token },
  });
  expect((await config()).default).toBe("fk");
});

test("the wizard reuses a key from the environment and stores nothing secret", async () => {
  const { prompt, asked } = scripted([
    [/Use FAKE_TOKEN/, true],
    [/Use FAKE_REGION=north/, true],
    [/fk network/, ""],
    [/Try a sandbox/, false],
  ]);

  const run = session({ FAKE_TOKEN: token, FAKE_REGION: "north" });
  const code = await runWizard(run, wizardFlags(), prompt);
  await run.close();

  expect(code).toBe(0);
  expect(asked.some((message) => message.includes("Where should beachside keep"))).toBe(false);
  expect((await config()).profiles.fk).toEqual({
    module: fixture,
    export: "initable",
    config: { environment: { kind: "prepared", value: "fake-starter" }, region: "north" },
    credentials: { token: "env:FAKE_TOKEN" },
  });
});

test("a wrong key in the wizard is reported and nothing is saved", async () => {
  const { prompt, said } = scripted([
    [/Paste your fk token/, "wrong"],
    [/fk region/, "north"],
    [/fk network/, ""],
  ]);

  const run = session();
  const code = await runWizard(run, wizardFlags(), prompt);
  await run.close();

  expect(code).toBe(5);
  expect(said.some((line) => line.includes("fk was not saved"))).toBe(true);
  await expect(stat(configPath())).rejects.toThrow();
});

test("cancelling the wizard exits 130 and leaves beachside.json as it was", async () => {
  const { prompt, said } = scripted([
    [/Paste your fk token/, token],
    [/fk region/, "cancel"],
  ]);

  const run = session();
  const code = await runWizard(run, wizardFlags(), prompt);
  await run.close();

  expect(code).toBe(130);
  expect(said).toContain("Cancelled; nothing was saved");
  await expect(stat(configPath())).rejects.toThrow();
});

test("with profiles already set up, the wizard offers to change the default", async () => {
  await mkdir(join(dir, "beachside"), { recursive: true });
  await writeFile(
    configPath(),
    JSON.stringify({
      default: "a",
      profiles: { a: { provider: "e2b" }, b: { provider: "boxd" } },
    }),
  );

  const { prompt } = scripted([
    [/You have 2 profile/, "default"],
    [/Which profile should be the default/, "b"],
  ]);

  const run = session();
  const code = await runWizard(run, new Flags({}, [], null), prompt);

  expect(code).toBe(0);
  expect((await config()).default).toBe("b");
});

test("the provider list ticks providers whose key is in the environment", async () => {
  let initial: string[] | undefined;
  const { prompt } = scripted([]);

  prompt.multiselect = async (options) => {
    initial = options.initial;
    throw new PromptCancelled();
  };

  const run = session({ E2B_API_KEY: "k", BOXD_API_KEY: "k" });
  const code = await runWizard(run, new Flags({}, [], null), prompt);

  expect(code).toBe(130);
  expect(initial).toEqual(["boxd", "e2b"]);
});

test("the repeat command never prints a key kept in beachside.json", () => {
  const draft: Draft = {
    name: "work",
    target: {
      id: "boxd",
      official: null,
      module: "@acme/adapter",
      export: "acme",
      label: "Acme",
    },
    setup: null,
    credentials: { apiKey: "plain-secret", other: "op://vault/item/field" },
    secrets: { extra: "pasted-secret" },
    config: {
      org: "org-1",
      flag: "true",
      environment: { kind: "prepared", value: "x y" },
    },
    previous: null,
    keychainId: "abcd1234",
  };

  const command = equivalentCommand(draft, "config", true);

  expect(command).not.toContain("secret");
  // Several piped keys are read one per line, --api-key first; a string that looks like JSON stays one.
  expect(command).toBe(
    `beachside init --module @acme/adapter --export acme --profile work --api-key - --credential other=op://vault/item/field --credential extra=- --set org=org-1 --set 'flag="true"' --set 'environment={"kind":"prepared","value":"x y"}' --default`,
  );
});

function stdinSession(text: string, flags: { provider?: string } = {}) {
  return new Session({
    env: baseEnv(),
    cwd: dir,
    out: new Output(false, { stdout: () => undefined, stderr: () => undefined }),
    flags: { json: false, ...flags },
    signal: new AbortController().signal,
    stdin: async function* () {
      yield new TextEncoder().encode(text);
    },
  });
}

const twoKeys = {
  credentials: { tokenId: { env: "FAKE_ID" }, tokenSecret: { env: "FAKE_SECRET" } },
};

test("several credentials given as - are read from stdin one per line, in flag order", async () => {
  const flags = new Flags({ credential: ["tokenSecret=-", "tokenId=-"] }, [], null);
  const given = await givenValues(stdinSession("secret-1\nid-1\n"), flags, twoKeys);

  expect(given.credentials).toEqual({ tokenSecret: "secret-1", tokenId: "id-1" });

  await expect(givenValues(stdinSession("only-one\n"), flags, twoKeys)).rejects.toThrow(
    "stdin needs 2 lines",
  );
});

test("--api-key is refused for an adapter with several credentials and no apiKey", async () => {
  const flags = new Flags({ "api-key": "k" }, [], null);

  await expect(givenValues(stdinSession(""), flags, twoKeys)).rejects.toThrow("no single API key");
});

test("--provider names the provider; it can't disagree with the argument", () => {
  expect(providerId(new Flags({ provider: "e2b" }, [], null))).toBe("e2b");
  expect(() => providerId(new Flags({ provider: "e2b" }, ["boxd"], null))).toThrow("two providers");
});

test("the wizard checks --profile and other flags before asking anything", async () => {
  const { prompt, asked } = scripted([]);
  const run = session();

  await expect(runWizard(run, wizardFlags({ profile: "bad name" }), prompt)).rejects.toThrow(
    "not usable",
  );
  await expect(
    runWizard(run, wizardFlags({ try: true, "no-check": true }), prompt),
  ).rejects.toThrow("--try needs the key check");
  await expect(runWizard(run, wizardFlags({ store: "disk" }), prompt)).rejects.toThrow(
    "--store is keychain or config",
  );
  await run.close();
  expect(asked).toHaveLength(0);
});

test("--no-check in the wizard saves without asking the provider or offering a sandbox", async () => {
  const { prompt, asked } = scripted([
    [/Paste your fk token/, "not-checked"],
    [/fk region/, "north"],
    [/fk network/, ""],
  ]);

  const run = session();
  const code = await runWizard(run, wizardFlags({ "no-check": true }), prompt);
  await run.close();

  expect(code).toBe(0);
  expect(asked.some((message) => message.includes("Try a sandbox"))).toBe(false);
  expect((await config()).profiles.fk.credentials).toEqual({ token: "not-checked" });
});

test("Ctrl-C while a test sandbox is being made saves nothing", async () => {
  const controller = new AbortController();

  const { prompt } = scripted([
    [/Paste your fk token/, token],
    [/fk region/, "north"],
    [/fk network/, ""],
  ]);

  prompt.confirm = async () => {
    controller.abort();

    return true;
  };

  const run = new Session({ ...session().ctx, signal: controller.signal });
  const code = await runWizard(run, wizardFlags(), prompt);
  await run.close();

  expect(code).toBe(130);
  await expect(stat(configPath())).rejects.toThrow();
});

test("a profile name taken by another provider is replaced only after asking", async () => {
  await mkdir(join(dir, "beachside"), { recursive: true });
  await writeFile(
    configPath(),
    JSON.stringify({ profiles: { fk: { provider: "e2b", credentials: { apiKey: "env:E2B" } } } }),
  );

  const { prompt, asked } = scripted([
    [/already a profile named fk/, "replace"],
    [/Paste your fk token/, token],
    [/fk region/, "north"],
    [/fk network/, ""],
    [/Try a sandbox/, false],
  ]);

  const run = session();
  const code = await runWizard(run, wizardFlags(), prompt);
  await run.close();

  expect(code).toBe(0);
  // Nothing of the e2b profile is merged in, and its key is not offered for reuse.
  expect(asked.some((message) => message.includes("Keep the current"))).toBe(false);
  expect((await config()).profiles.fk.credentials).toEqual({ token });
  expect((await config()).profiles.fk.provider).toBeUndefined();
});

test.skipIf(process.platform === "darwin")(
  "Ctrl-C while a key is being stored leaves no keychain item and no profile",
  async () => {
    const bin = await fakeSecretTool(true);
    const controller = new AbortController();

    const run = new Session({
      ...session({ PATH: `${bin}:${process.env.PATH ?? ""}` }).ctx,
      signal: controller.signal,
    });

    const draft: Draft = {
      name: "fk",
      target: officialTarget(descriptor("e2b")!),
      setup: null,
      credentials: {},
      secrets: { apiKey: "pasted" },
      config: {},
      previous: null,
      keychainId: newKeychainId(),
    };

    setTimeout(() => controller.abort(), 300);
    await expect(writeProfiles(run, [draft], "keychain", "fk")).rejects.toThrow("Interrupted");
    await run.close();

    expect(await readdir(join(dir, "keyring"))).toEqual([]);
    await expect(stat(configPath())).rejects.toThrow();
  },
);

test("replacing a profile for another adapter drops its setup steps and keys", async () => {
  await mkdir(join(dir, "beachside"), { recursive: true });
  await writeFile(
    configPath(),
    JSON.stringify({
      profiles: {
        fk: { provider: "e2b", credentials: { token: token }, setup: ["node"] },
      },
    }),
  );

  const result = await cli(
    [...fake, "--api-key", "-", "--set", "region=north", "--store", "config", "--force", "--json"],
    {},
    `${token}\n`,
  );

  expect(result).toMatchObject({ code: 0 });
  expect(JSON.parse(result.stdout).data.result).toBe("updated");

  const profile = (await config()).profiles.fk;

  expect(profile.setup).toBeUndefined();
  expect(profile.provider).toBeUndefined();
  expect(profile.credentials).toEqual({ token });
});

test("the guided setup refuses a key given as -, since stdin is the keyboard", async () => {
  const { prompt, asked } = scripted([]);
  const run = session();

  await expect(runWizard(run, wizardFlags({ "api-key": "-" }), prompt)).rejects.toThrow(
    "read from a pipe",
  );
  await run.close();
  expect(asked).toHaveLength(0);
});
