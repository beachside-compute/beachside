import {
  NonzeroExitError,
  SetupFailedError,
  type ExecOutput,
  type SandboxHandle,
  type SetupRunOptions,
  type SetupStepOptions,
} from "beachside";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CliError, usage, type Output } from "./output";
import { shellQuote } from "./transfer";

/**
 * Servers `create --with` installs in a sandbox. Each one joins the user's tailnet with the
 * auth key in TAILSCALE_AUTH_KEY, which only ever reaches the sandbox over a command's stdin.
 */
export const addonNames = ["rex", "herdr"] as const;

export type AddonName = (typeof addonNames)[number];

export const AddonRecord = z.strictObject({
  name: z.enum(addonNames),
  /** The tailnet device name the add-on asked for. */
  hostname: z.string().min(1),
  /**
   * `setting-up` is saved before the add-on can join the tailnet and `failed` after a failed
   * setup, so `rm` still logs its device out.
   */
  state: z.enum(["setting-up", "ready", "failed"]),
  /** How to reach it once ready: Rex's https address, or the herdr-core `hc machine add` command. */
  connect: z.string().min(1).optional(),
  /**
   * herdr: `known_hosts` lines for the device's Tailscale SSH host keys, read inside the sandbox
   * over the provider's channel, so the first connect can be checked rather than trusted.
   */
  knownHosts: z.array(z.string().min(1)).optional(),
});

export type AddonRecord = z.infer<typeof AddonRecord>;

const keyVariable = "TAILSCALE_AUTH_KEY";

/** Where herdr's userspace tailscaled keeps its state, socket and any host keys Beachside made. */
const herdrState = `"$HOME/.local/state/beachside/tailscale"`;

/** The requested add-ons, deduplicated and in a stable order. */
export function parseAddons(values: string[]): AddonName[] {
  const names = new Set<AddonName>();

  for (const value of values.flatMap((entry) => entry.split(","))) {
    const name = value.trim();
    const known = addonNames.find((candidate) => candidate === name);

    if (!known) throw usage(`Unknown --with ${name}`, `choose from ${addonNames.join(", ")}`);
    names.add(known);
  }

  return addonNames.filter((name) => names.has(name));
}

/** The auth key, checked before anything is created. Never echoed. */
export function tailnetKey(env: Record<string, string | undefined>): string {
  const key = env[keyVariable]?.trim();

  if (!key)
    throw usage(
      `--with needs ${keyVariable}: a reusable, ephemeral, pre-approved Tailscale auth key tagged tag:beachside`,
      "see https://beachside.run/docs/cli/rex/#set-up-tailscale-once",
    );

  return key;
}

/**
 * Tailnet names: `beachside-<sandbox>`. Herdr's SSH device keeps the plain name; Rex, which runs
 * its own Tailscale, takes `-rex` when both are installed, so the two devices never clash.
 */
export function addonHostname(name: AddonName, sandbox: string, all: AddonName[]): string {
  const base = `beachside-${sandbox}`;

  return name === "rex" && all.includes("herdr") ? `${base}-rex` : base;
}

/**
 * One add-on script. `read` marks a step that only looks (a log, a status) and whose stdout the
 * add-on needs; every other step installs or starts something and runs as a setup step.
 */
type Step = {
  what: string;
  script: string;
  stdin?: string;
  deadlineSeconds?: number;
  read?: boolean;
};

/** What a setup script printed and how it ended. */
export type ShellResult = { exitCode: number | null; stdout: string; stderr: string };

/** Runs one shell script in the sandbox; `sandboxShell` builds it from a handle. */
export type Shell = (step: Step, signal: AbortSignal) => Promise<ShellResult>;

/**
 * The production shell: install and start steps run on Beachside's setup engine (live output,
 * the same failure reporting as `--setup`, outside the sandbox's own setup record); reads run as
 * plain commands, since the add-on needs what they print.
 */
export function setupShell(box: SandboxHandle<true>, progress: SetupRunOptions): Shell {
  const plain = sandboxShell(box);

  return async (step, signal) => {
    if (step.read) return plain(step, signal);

    const setupStep: SetupStepOptions = {
      run: step.script,
      name: step.what,
      timeoutSeconds: step.deadlineSeconds ?? 300,
    };

    if (step.stdin !== undefined) setupStep.stdin = step.stdin;

    try {
      await box.runSetup({ setup: [setupStep], record: false, ...progress }, { signal });

      return { exitCode: 0, stdout: "", stderr: "" };
    } catch (cause) {
      if (!(cause instanceof SetupFailedError)) throw cause;

      return {
        exitCode: cause.exitCode,
        stdout: cause.stdoutTail,
        stderr: cause.stderrTail || cause.message,
      };
    }
  };
}

export function sandboxShell(box: SandboxHandle<true>): Shell {
  return async (step, signal) => {
    let result: ExecOutput;

    try {
      result = await box.exec(
        {
          command: { kind: "shell", script: step.script },
          stdin: step.stdin,
          deadlineSeconds: step.deadlineSeconds ?? 300,
        },
        { signal },
      );
    } catch (cause) {
      if (!(cause instanceof NonzeroExitError)) throw cause;
      result = cause.result;
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdoutText({ full: true }),
      stderr: result.stderrText({ full: true }),
    };
  };
}

/** Run one setup script; a nonzero exit becomes an error naming the step and its stderr tail. */
async function run(shell: Shell, step: Step, signal: AbortSignal): Promise<string> {
  const result = await shell(step, signal);

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim().split("\n").slice(-5).join("\n");

    throw new Error(`${step.what} failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`);
  }

  return result.stdout;
}

/** `sudo -n` unless already root, for scripts that need it. */
const asRoot = `S=; [ "$(id -u)" = 0 ] || S="sudo -n"`;

/**
 * Tailscale treats a machine whose only IPv4 address is link-local as offline and never logs in
 * (E2B: e2b-dev/runtime#3780). Give such a machine one routable host address.
 */
const routableIpv4 = [
  asRoot,
  // E2B marks its link-local address scope global, so skip 169.254.0.0/16 explicitly.
  "if command -v ip >/dev/null && ! ip -4 -o addr show scope global | grep -v ' inet 169\\.254\\.' | grep -q .; then",
  "  $S ip addr add 192.0.0.8/32 dev eth0 noprefixroute 2>/dev/null || true",
  "fi",
].join("\n");

const needsInternet =
  "the sandbox needs internet access; pass --network internet or use a provider tier that allows it";

function download(url: string, what: string): string {
  return [
    `if ! command -v curl >/dev/null; then echo "curl is not installed" >&2; exit 3; fi`,
    `curl -fsSL ${shellQuote(url)} | sh >/dev/null || { echo "could not install ${what}: ${needsInternet}" >&2; exit 3; }`,
  ].join("\n");
}

const readyLine = "tailnet https listener ready";

async function setupRex(
  shell: Shell,
  hostname: string,
  key: string,
  signal: AbortSignal,
  out: Output,
): Promise<AddonRecord> {
  const host = shellQuote(hostname);

  out.note(`rex: installing in ${hostname}`);
  await run(
    shell,
    {
      what: "Installing Rex",
      script: `command -v rex >/dev/null || { ${download("https://pkgs.superlogical.com/rex/install.sh", "Rex")}\n}`,
    },
    signal,
  );

  // Old tsnet state, such as one baked into an image, makes Rex ignore the auth key and would
  // share another sandbox's identity. `create` refuses --snapshot with --with, so a restored
  // sandbox never reaches this.
  await run(
    shell,
    {
      what: "Starting the Rex server",
      script: `rm -rf "$HOME/.local/state/rex/tsnet"\nrex server start --tailscale-hostname ${host}`,
    },
    signal,
  );

  // A detached `rex server start` cannot read stdin, so the key goes to `tailscale on`.
  await run(
    shell,
    {
      what: "Joining the tailnet",
      script: `rex server tailscale on --hostname ${host} --auth-key-file - --allow-tailnet-members`,
      stdin: key,
    },
    signal,
  );

  out.note(`rex: waiting for its https certificate (up to a minute)`);
  const url = await rexAddress(shell, signal);

  // The first request waits on certificate issuance, longer than Rex's own handshake timeout.
  try {
    await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
  } catch {
    // This machine may not be on the tailnet; Rex still works from the user's Mac.
  }

  return { name: "rex", hostname, state: "ready", connect: url };
}

/** Poll Rex's log for the tailnet listener and return its https address. */
async function rexAddress(shell: Shell, signal: AbortSignal): Promise<string> {
  const deadline = Date.now() + 150_000;

  while (Date.now() < deadline) {
    const logs = await run(
      shell,
      {
        what: "Reading the Rex server log",
        script: "rex server logs 2>&1 | tail -n 200 || true",
        read: true,
      },
      signal,
    );

    const line = logs.split("\n").find((entry) => entry.includes(readyLine));
    const url = line?.match(/url=(https:\/\/\S+)/)?.[1];

    if (url) return url.replace(/[",]+$/, "");

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(
    `Rex did not report "${readyLine}" within 150s; check the key and \`beachside exec <name> -- rex server logs\``,
  );
}

/** `tailscale status --json` text, reduced to this device's MagicDNS name. */
const TailscaleStatus = z
  .string()
  .transform((text, ctx) => {
    try {
      return JSON.parse(text);
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });

      return z.NEVER;
    }
  })
  .pipe(z.object({ Self: z.object({ DNSName: z.string() }) }));

/** The SSH user the sandbox reports; it lands in a command people paste, so it must be plain. */
const sshUser = /^[a-z_][a-z0-9_.-]{0,31}$/i;

/** A MagicDNS name: dot-separated labels of letters, digits and inner hyphens. */
const dnsLabel = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * A Tailscale SSH device for Herdr. The connect line adds it to herdr-core (the Herdr app's
 * server) as a short-lived machine named after the sandbox; `--install` puts a matching `hc`
 * there on first connect.
 */
async function setupHerdr(
  shell: Shell,
  sandbox: string,
  hostname: string,
  key: string,
  signal: AbortSignal,
  out: Output,
): Promise<AddonRecord> {
  const state = herdrState;
  const socket = `--socket=${state}/tailscaled.sock`;

  out.note(`herdr: putting ${hostname} on your tailnet with Tailscale SSH`);
  await run(
    shell,
    {
      what: "Installing Tailscale",
      script: [
        asRoot,
        `command -v tailscaled >/dev/null || { ${download("https://tailscale.com/install.sh", "Tailscale")}\n}`,
        // The install script may enable the system service; this sandbox runs its own userspace one.
        "$S systemctl disable --now tailscaled >/dev/null 2>&1 || true",
      ].join("\n"),
    },
    signal,
  );

  await run(
    shell,
    { what: "Preparing SSH host keys", script: hostKeysPrepareScript(state) },
    signal,
  );

  await run(
    shell,
    {
      what: "Starting tailscaled",
      script: [
        asRoot,
        `mkdir -p ${state}`,
        // --statedir is what `tailscale serve` and SSH need even with in-memory state.
        `$S setsid -f tailscaled --tun=userspace-networking --state=mem: --statedir=${state} ${socket} </dev/null >${state}/tailscaled.log 2>&1`,
        `for _ in $(seq 1 50); do [ -S ${state}/tailscaled.sock ] && exit 0; sleep 0.2; done`,
        `echo "tailscaled did not start; see ${state}/tailscaled.log" >&2; exit 1`,
      ].join("\n"),
    },
    signal,
  );

  await run(
    shell,
    {
      what: "Joining the tailnet",
      script: `${asRoot}\n$S tailscale ${socket} up --auth-key=file:/dev/stdin --ssh --timeout=120s --hostname=${shellQuote(hostname)}`,
      stdin: key,
    },
    signal,
  );

  const status = await run(
    shell,
    {
      what: "Reading the tailnet name",
      script: `${asRoot}\nid -un\n$S tailscale ${socket} status --json --peers=false`,
      read: true,
    },
    signal,
  );

  const [user = "root", ...json] = status.split("\n");
  const parsed = TailscaleStatus.safeParse(json.join("\n"));

  const dnsName = parsed.success ? parsed.data.Self.DNSName.replace(/\.$/, "") : hostname;

  if (!sshUser.test(user) || !dnsLabel.test(dnsName))
    throw new Error(`the sandbox reported an unexpected SSH user or tailnet name`);

  const keys = await run(
    shell,
    { what: "Reading the SSH host keys", script: hostKeysScript(state), read: true },
    signal,
  );

  const knownHosts = hostKeys(keys).map((entry) => `${dnsName} ${entry}`);

  const record: AddonRecord = {
    name: "herdr",
    hostname,
    state: "ready",
    connect: `hc machine add ${user}@${dnsName} --temp --install${hcName(sandbox)}`,
  };

  if (knownHosts.length) record.knownHosts = knownHosts;

  return record;
}

/**
 * herdr-core refuses a machine name over 32 characters or shaped like a terminal id (`t7`, `t1b`).
 * Without `--name` it names the machine after the host's first label, adding a suffix if taken.
 */
function hcName(sandbox: string): string {
  return sandbox.length <= 32 && !/^t\d+[a-z]?$/.test(sandbox) ? ` --name ${sandbox}` : "";
}

/**
 * Tailscale SSH serves, for each key type, the system key in /etc/ssh when there is one, else its
 * own under `--statedir`. It writes its own as PKCS#8 with no `.pub`, which `ssh-keygen` cannot
 * read for ED25519, so before tailscaled starts, any missing type is made here with `ssh-keygen`,
 * which writes the `.pub` too. Without `ssh-keygen`, Tailscale makes them and no keys are known.
 */
function hostKeysPrepareScript(state: string): string {
  return [
    asRoot,
    "command -v ssh-keygen >/dev/null || exit 0",
    // The state folder stays the user's: the next step writes tailscaled's log there unprivileged.
    `mkdir -p ${state}`,
    `$S mkdir -p -m 700 ${state}/ssh`,
    "for t in ed25519 ecdsa rsa; do",
    '  $S test -s "/etc/ssh/ssh_host_${t}_key" && continue',
    `  k=${state}/ssh/ssh_host_\${t}_key`,
    '  $S test -s "$k" || $S ssh-keygen -q -t "$t" -N "" -C beachside -f "$k" </dev/null',
    "done",
  ].join("\n");
}

/** The public half of each key `hostKeysPrepareScript` left Tailscale SSH to serve. */
function hostKeysScript(state: string): string {
  return [
    asRoot,
    "for t in ed25519 ecdsa rsa; do",
    "  k=/etc/ssh/ssh_host_${t}_key",
    `  $S test -s "$k" || k=${state}/ssh/ssh_host_\${t}_key`,
    '  $S test -s "$k.pub" && $S cat "$k.pub"',
    "done",
    "true",
  ].join("\n");
}

/** A public key's type and base64 blob, anywhere in a line (a `.pub` file or `known_hosts`). */
const publicKey =
  /(?:^|\s)(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)\s+([A-Za-z0-9+/]+={0,2})(?=\s|$)/;

/** `<type> <base64>` for each well-formed key line, dropping comments and anything else. */
function hostKeys(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const match = publicKey.exec(line.trim());

    return match ? [`${match[1]} ${match[2]}`] : [];
  });
}

/**
 * OpenSSH's fingerprint, as ssh prints it, for a `<type> <base64>` key, a `.pub` line or a
 * `known_hosts` line, comments included.
 */
export function hostKeyFingerprint(entry: string): string {
  const blob = publicKey.exec(entry.trim())?.[2] ?? "";

  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

/** Saves the add-ons as they stand, so an interrupted create still leaves them on record. */
export type SaveAddons = (addons: AddonRecord[]) => Promise<void>;

/**
 * Install and start each add-on in order. Each one is saved as `setting-up` before it can join
 * the tailnet and again once it is ready, so `rm` can log its device out even if this process
 * dies partway. The sandbox is kept on failure, for inspection.
 */
export async function setupAddons(
  shell: Shell,
  sandbox: string,
  names: AddonName[],
  key: string,
  signal: AbortSignal,
  out: Output,
  save: SaveAddons,
): Promise<{ addons: AddonRecord[]; failure?: CliError }> {
  const addons: AddonRecord[] = [];

  try {
    await run(shell, { what: "Checking the network", script: routableIpv4 }, signal);

    for (const name of names) {
      const hostname = addonHostname(name, sandbox, names);

      addons.push({ name, hostname, state: "setting-up" });
      await save([...addons]);
      addons[addons.length - 1] =
        name === "rex"
          ? await setupRex(shell, hostname, key, signal, out)
          : await setupHerdr(shell, sandbox, hostname, key, signal, out);
      await save([...addons]);
    }

    return { addons };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    const pending = names.filter(
      (name) => !addons.some((addon) => addon.name === name && addon.state === "ready"),
    );

    for (const [index, addon] of addons.entries())
      if (addon.state === "setting-up") addons[index] = { ...addon, state: "failed" };

    try {
      await save([...addons]);
    } catch {
      // The `setting-up` entry already on record still lets `rm` log the device out.
    }

    return {
      addons,
      failure: new CliError(
        "PARTIAL",
        `Created ${sandbox}, but setting up ${pending.join(", ")} failed: ${message}`,
        `inspect it with \`beachside exec ${sandbox} -- …\`, or remove it with \`beachside rm ${sandbox}\``,
        { sandbox },
        "partial",
      ),
    };
  }
}

/** The script that logs each add-on's device out of the tailnet. */
const logoutScripts: Record<AddonName, string> = {
  // `logout` directly: after `off`, Rex keeps the saved login and the device lingers offline.
  rex: "rex server tailscale logout",
  herdr: `${asRoot}\n$S tailscale --socket="$HOME/.local/state/beachside/tailscale/tailscaled.sock" logout`,
};

/**
 * Log each add-on's device out before its sandbox goes away, so it leaves the tailnet at once
 * instead of lingering offline and holding its name. Best effort.
 */
export async function teardownAddons(
  shell: Shell,
  addons: AddonRecord[],
  signal: AbortSignal,
): Promise<void> {
  for (const addon of addons) {
    try {
      await shell(
        {
          what: `Logging ${addon.name} out`,
          script: logoutScripts[addon.name],
          deadlineSeconds: 30,
        },
        signal,
      );
    } catch {
      // Ephemeral devices leave the tailnet on their own once the sandbox is gone.
    }
  }
}

/** One line per add-on for human output. */
export function addonLines(addons: AddonRecord[]): string[] {
  return addons.flatMap((addon) => {
    const name = addon.name.padEnd(10);

    if (addon.state !== "ready")
      return [
        `${name}setup ${addon.state === "failed" ? "failed" : "unfinished"} (${addon.hostname})`,
      ];

    if (addon.name === "rex") return [`${name}${addon.connect}`];

    const fingerprint = ed25519Fingerprint(addon.knownHosts);

    return [
      `${name}${addon.connect}  (adds it to the Herdr app)`,
      ...(fingerprint
        ? [`${"".padEnd(10)}host key ${fingerprint} (ED25519): check it when ssh asks`]
        : []),
    ];
  });
}

/** ssh asks about the ED25519 key first, so that is the fingerprint people compare. */
function ed25519Fingerprint(knownHosts: string[] | undefined): string | undefined {
  const entry = knownHosts?.find((line) => line.includes(" ssh-ed25519 "));

  return entry ? hostKeyFingerprint(entry) : undefined;
}

/** The same keys, in any order. */
function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

/**
 * herdr: read the host keys the sandbox serves now, over the provider. They are not fixed: a
 * restore, a rebuilt image or a regenerated key changes them after `create` recorded them, so
 * `inspect` reads them again rather than reprinting old ones. A changed key replaces the recorded
 * one and is reported; a read that fails keeps the recorded keys and says they were not checked.
 */
export async function refreshHostKeys(
  shell: Shell,
  addons: AddonRecord[],
  signal: AbortSignal,
): Promise<{ addons: AddonRecord[]; notes: string[]; changed: boolean }> {
  const notes: string[] = [];
  let changed = false;

  const refreshed: AddonRecord[] = [];

  for (const addon of addons) {
    const dnsName = addon.state === "ready" ? herdrTarget(addon)?.split("@")[1] : undefined;

    if (addon.name !== "herdr" || !dnsName) {
      refreshed.push(addon);
      continue;
    }

    let read: ShellResult | undefined;

    try {
      read = await shell(
        {
          what: "Reading the SSH host keys",
          script: hostKeysScript(herdrState),
          read: true,
          deadlineSeconds: 30,
        },
        signal,
      );
    } catch {
      read = undefined;
    }

    if (!read || read.exitCode !== 0) {
      notes.push(
        `herdr: could not read ${dnsName}'s SSH host keys now; any fingerprint shown was recorded at create and may be out of date`,
      );
      refreshed.push(addon);
      continue;
    }

    const recorded = addon.knownHosts ?? [];
    const current = hostKeys(read.stdout).map((entry) => `${dnsName} ${entry}`);

    if (sameKeys(recorded, current)) {
      refreshed.push(addon);
      continue;
    }

    changed = true;

    const { knownHosts: _old, ...rest } = addon;

    refreshed.push(current.length ? { ...rest, knownHosts: current } : rest);

    const was = ed25519Fingerprint(recorded) ?? "none readable";
    const now = ed25519Fingerprint(current) ?? "none readable";

    notes.push(
      `herdr: ${dnsName}'s SSH host keys changed since they were recorded (ED25519 was ${was}, now ${now}). If ssh refuses it as changed, compare the new fingerprint, then drop the old entry with \`ssh-keygen -R ${dnsName}\``,
    );
  }

  return { addons: refreshed, notes, changed };
}

/** A machine herdr-core knows, as `hc machine ls --json` lists it. */
export type HcMachine = { name: string; target: string };

const HcMachines = z.object({
  machines: z.array(z.object({ name: z.string(), target: z.string().nullable().optional() })),
});

/**
 * The machines this computer's herdr-core knows, or null when `hc` is not here or does not
 * answer. Read only: Beachside never adds or forgets machines itself.
 */
export async function hcMachines(
  env: Record<string, string | undefined>,
): Promise<HcMachine[] | null> {
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      "hc",
      ["machine", "ls", "--json"],
      { env, timeout: 5000, encoding: "utf8" },
      (error, text) => resolve(error ? null : text),
    );
  });

  if (stdout === null) return null;

  try {
    const parsed = HcMachines.safeParse(JSON.parse(stdout));

    return parsed.success
      ? parsed.data.machines.flatMap((machine) =>
          machine.target ? [{ name: machine.name, target: machine.target }] : [],
        )
      : null;
  } catch {
    return null;
  }
}

/** The `user@address` a ready herdr add-on's connect line hands to `hc machine add`. */
function herdrTarget(addon: AddonRecord): string | undefined {
  return addon.connect?.match(/^hc machine add (\S+)/)?.[1];
}

/** Whether removing the sandbox needs a word about herdr-core, which keeps machines it added. */
export function hasHerdr(addons: AddonRecord[]): boolean {
  return addons.some((addon) => addon.name === "herdr" && addon.state === "ready");
}

/**
 * After `rm` or `gc`: herdr-core keeps a machine until it is told to forget it, and its name may
 * not be the sandbox's (a taken name gets a suffix), so name the ones whose target is this
 * sandbox's. `machines` null means `hc` could not be asked here. ssh also keeps the host key it
 * accepted, and a later sandbox with this name has its own key, so say how to drop that too.
 */
export function removedAddonNotes(
  sandbox: string,
  addons: AddonRecord[],
  machines: HcMachine[] | null,
): string[] {
  return addons.flatMap((addon) => {
    const target =
      addon.name === "herdr" && addon.state === "ready" ? herdrTarget(addon) : undefined;

    if (!target) return [];

    const dnsName = target.split("@")[1];

    const knownHost = `ssh: if ssh saved a host key for ${dnsName}, drop it with \`ssh-keygen -R ${dnsName}\`, so a new sandbox with this name is not refused as a changed host`;

    if (!machines)
      return [
        `herdr: if you added ${sandbox} to Herdr, forget it with \`hc machine rm <name>\`, using the name \`hc machine ls\` shows for ${target}`,
        knownHost,
      ];

    return [
      ...machines
        .filter((machine) => machine.target === target)
        .map(
          (machine) => `herdr: forget ${sandbox} in Herdr with \`hc machine rm ${machine.name}\``,
        ),
      knownHost,
    ];
  });
}
