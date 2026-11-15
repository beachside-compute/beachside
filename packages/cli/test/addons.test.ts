import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import {
  addonHostname,
  addonLines,
  hostKeyFingerprint,
  removedAddonNotes,
  parseAddons,
  setupAddons,
  tailnetKey,
  teardownAddons,
  type AddonRecord,
  type Shell,
} from "../src/addons";
import { Output } from "../src/output";

type Call = { script: string; stdin?: string };

type Reply = { exitCode?: number; stdout?: string; stderr?: string };

/** A sandbox shell that answers each script with the first matching reply and records calls. */
function scriptedShell(replies: [RegExp, Reply][]) {
  const calls: Call[] = [];

  const shell: Shell = async (step) => {
    calls.push({ script: step.script, stdin: step.stdin });

    const reply = replies.find(([pattern]) => pattern.test(step.script))?.[1] ?? {};

    return {
      exitCode: reply.exitCode ?? 0,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
    };
  };

  return { shell, calls };
}

/** A throwaway key; its fingerprint is what `ssh-keygen -lf` printed for it. */
const fixtureKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHN0O4xR7Qmd1HlEAEfyJhxvoVewkD+/p6lN32r12xJJ";

const fixtureFingerprint = "SHA256:NKRhYS3A2e3YAkoEK2+tsFziu50IZKY8dQ/LfGH3maE";

function quietOutput(): Output {
  return new Output(true, { stdout: () => {}, stderr: () => {} });
}

describe("add-on helpers", () => {
  test("parse --with values, deduplicated in a stable order", () => {
    expect(parseAddons(["herdr", "rex,herdr"])).toEqual(["rex", "herdr"]);
    expect(() => parseAddons(["orca"])).toThrow("Unknown --with orca");
  });

  test("name tailnet devices after the sandbox, Rex apart when herdr is also there", () => {
    expect(addonHostname("rex", "web", ["rex"])).toBe("beachside-web");
    expect(addonHostname("rex", "web", ["rex", "herdr"])).toBe("beachside-web-rex");
    expect(addonHostname("herdr", "web", ["rex", "herdr"])).toBe("beachside-web");
  });

  test("the auth key is required and never appears in the message", () => {
    expect(() => tailnetKey({})).toThrow("TAILSCALE_AUTH_KEY");
    expect(tailnetKey({ TAILSCALE_AUTH_KEY: " tskey-auth-x " })).toBe("tskey-auth-x");
  });
});

describe("setupAddons", () => {
  const key = "tskey-auth-secret";
  let saved: AddonRecord[][] = [];

  beforeEach(() => {
    saved = [];
  });

  test("rex: installs, starts, joins with the key over stdin only, and reports its address", async () => {
    const { shell, calls } = scriptedShell([
      [
        /rex server logs/,
        { stdout: `info tailnet https listener ready url=https://beachside-web.tail1.ts.net\n` },
      ],
    ]);

    const result = await setupAddons(
      shell,
      "web",
      ["rex"],
      key,
      AbortSignal.timeout(90_000),
      quietOutput(),
      async (addons) => {
        saved.push(addons);
      },
    );

    expect(result.failure).toBeUndefined();
    expect(result.addons).toEqual([
      {
        name: "rex",
        hostname: "beachside-web",
        state: "ready",
        connect: "https://beachside-web.tail1.ts.net",
      },
    ]);
    expect(calls.map((call) => call.script).filter((script) => script.includes(key))).toEqual([]);
    expect(calls.filter((call) => call.stdin === key).map((call) => call.script)).toEqual([
      "rex server tailscale on --hostname 'beachside-web' --auth-key-file - --allow-tailnet-members",
    ]);
    expect(calls[0]!.script).toContain("192.0.0.8/32");
    expect(calls.some((call) => call.script.includes(".local/state/rex/tsnet"))).toBe(true);
    // On record as setting-up before it can join, so a killed create still logs it out on rm.
    expect(saved.map((addons) => addons.map((addon) => addon.state))).toEqual([
      ["setting-up"],
      ["ready"],
    ]);
  }, 90_000);

  test("herdr: Tailscale SSH device and the herdr-core command that adds it", async () => {
    const { shell, calls } = scriptedShell([
      [/status --json/, { stdout: `ubuntu\n{"Self":{"DNSName":"beachside-web.tail1.ts.net."}}` }],
      [/ssh_host_/, { stdout: `${fixtureKey} root@fixture\nnot a key\n` }],
    ]);

    const result = await setupAddons(
      shell,
      "web",
      ["herdr"],
      key,
      AbortSignal.timeout(10_000),
      quietOutput(),
      async (addons) => {
        saved.push(addons);
      },
    );

    expect(result.addons).toEqual([
      {
        name: "herdr",
        hostname: "beachside-web",
        state: "ready",
        connect: "hc machine add ubuntu@beachside-web.tail1.ts.net --temp --install --name web",
        knownHosts: [`beachside-web.tail1.ts.net ${fixtureKey}`],
      },
    ]);
    const join = calls.find((call) => call.stdin === key)!;
    expect(join.script).toContain(
      "up --auth-key=file:/dev/stdin --ssh --timeout=120s --hostname='beachside-web'",
    );
    expect(calls.some((call) => call.script.includes("--statedir="))).toBe(true);
    expect(addonLines(result.addons)).toEqual([
      "herdr     hc machine add ubuntu@beachside-web.tail1.ts.net --temp --install --name web  (adds it to the Herdr app)",
      `          host key ${fixtureFingerprint} (ED25519): check it when ssh asks`,
    ]);
    // System keys first, Tailscale's own under --statedir otherwise.
    const read = calls.find((call) => call.script.includes("ssh_host_"))!;
    expect(read.script).toContain("/etc/ssh/ssh_host_${t}_key");
    expect(read.script).toContain('/.local/state/beachside/tailscale"/ssh/ssh_host_${t}_key');
  });

  test("herdr: no host keys found leaves no knownHosts and no fingerprint line", async () => {
    const { shell } = scriptedShell([
      [/status --json/, { stdout: `ubuntu\n{"Self":{"DNSName":"beachside-web.tail1.ts.net."}}` }],
    ]);

    const result = await setupAddons(
      shell,
      "web",
      ["herdr"],
      key,
      AbortSignal.timeout(10_000),
      quietOutput(),
      async () => {},
    );

    expect(result.addons[0]!.knownHosts).toBeUndefined();
    expect(addonLines(result.addons)).toHaveLength(1);
  });

  test("host key fingerprints match ssh-keygen -l", () => {
    expect(hostKeyFingerprint(fixtureKey)).toBe(fixtureFingerprint);
    expect(hostKeyFingerprint(`beachside-web.tail1.ts.net ${fixtureKey}`)).toBe(fixtureFingerprint);
  });

  test("herdr: refuses a reported user or name that is not safe to paste", async () => {
    const { shell } = scriptedShell([
      [
        /status --json/,
        { stdout: `x;rm -rf ~\n{"Self":{"DNSName":"beachside-web.tail1.ts.net."}}` },
      ],
    ]);

    const result = await setupAddons(
      shell,
      "web",
      ["herdr"],
      key,
      AbortSignal.timeout(10_000),
      quietOutput(),
      async () => {},
    );

    expect(result.addons).toEqual([{ name: "herdr", hostname: "beachside-web", state: "failed" }]);
    expect(result.failure?.message).toContain("unexpected SSH user or tailnet name");
  });

  test("rm notes how to forget a ready herdr machine in herdr-core", () => {
    expect(
      removedAddonNotes("web", [{ name: "herdr", hostname: "beachside-web", state: "ready" }]),
    ).toEqual(["herdr: if you added web to Herdr, forget it with `hc machine rm web`"]);
    expect(
      removedAddonNotes("web", [{ name: "herdr", hostname: "beachside-web", state: "failed" }]),
    ).toEqual([]);
    expect(removedAddonNotes("web", [])).toEqual([]);
  });

  test("a failed step keeps what was ready and names the step", async () => {
    const { shell } = scriptedShell([
      [/install\.sh/, { exitCode: 3, stderr: "could not install Rex: the sandbox needs internet" }],
    ]);

    const result = await setupAddons(
      shell,
      "web",
      ["rex"],
      key,
      AbortSignal.timeout(10_000),
      quietOutput(),
      async (addons) => {
        saved.push(addons);
      },
    );

    expect(result.addons).toEqual([{ name: "rex", hostname: "beachside-web", state: "failed" }]);
    expect(addonLines(result.addons)).toEqual(["rex       setup failed (beachside-web)"]);
    expect(result.failure?.code).toBe("PARTIAL");
    expect(result.failure?.message).toContain("Installing Rex failed (exit 3)");
    expect(result.failure?.message).not.toContain(key);
    expect(saved.at(-1)).toEqual([{ name: "rex", hostname: "beachside-web", state: "failed" }]);
  });
});

describe("teardownAddons", () => {
  test("logs every device out, Rex with logout rather than off", async () => {
    const { shell, calls } = scriptedShell([]);

    await teardownAddons(
      shell,
      [
        { name: "rex", hostname: "beachside-web-rex", state: "ready", connect: "https://x" },
        { name: "herdr", hostname: "beachside-web", state: "failed" },
      ],
      AbortSignal.timeout(5000),
    );

    expect(calls.map((call) => call.script.split("\n").at(-1))).toEqual([
      "rex server tailscale logout",
      '$S tailscale --socket="$HOME/.local/state/beachside/tailscale/tailscaled.sock" logout',
    ]);
  });
});

describe("the routable IPv4 check", () => {
  async function addsAddress(addresses: string): Promise<boolean> {
    const { shell, calls } = scriptedShell([[/install\.sh/, { exitCode: 3 }]]);

    await setupAddons(
      shell,
      "web",
      ["rex"],
      "k",
      AbortSignal.timeout(5000),
      quietOutput(),
      async () => {},
    );

    const dir = await mkdtemp(join(tmpdir(), "beachside-ip-"));
    const log = join(dir, "added");

    try {
      await writeFile(
        join(dir, "ip"),
        `#!/bin/sh\ncase "$*" in *"addr add"*) echo "$*" >> ${log} ;; *) printf '%s\\n' ${JSON.stringify(addresses)} ;; esac\n`,
        { mode: 0o755 },
      );
      await writeFile(join(dir, "sudo"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });

      const done = Bun.spawnSync(["sh", "-c", calls[0]!.script], {
        env: { PATH: `${dir}:/usr/bin:/bin` },
      });

      expect(done.exitCode).toBe(0);

      return (await readdir(dir)).includes("added");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("adds 192.0.0.8 when the only IPv4 is link-local, even marked scope global (E2B)", async () => {
    expect(
      await addsAddress("2: eth0    inet 169.254.0.21/30 brd 169.254.0.23 scope global eth0"),
    ).toBe(true);
  });

  test("leaves a sandbox with a routable IPv4 alone", async () => {
    expect(await addsAddress("2: eth0    inet 10.40.1.5/24 scope global eth0")).toBe(false);
  });
});

describe("create --with", () => {
  const token = "local-test-token-12345";
  let root: string;
  let server: Awaited<ReturnType<typeof startFakeProviderServer>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "beachside-addons-"));
    server = await startFakeProviderServer({
      hostname: "127.0.0.1",
      port: 0,
      statePath: join(root, "fake.json"),
      token,
      testMode: true,
    });
    await writeFile(
      join(root, "beachside.json"),
      JSON.stringify({
        default: "fake",
        profiles: { fake: { module: join(import.meta.dir, "fake-adapter.ts"), export: "fake" } },
      }),
    );
  });

  afterAll(async () => {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  // A child process, so the fixture adapter binds to this file's fake server rather than one
  // another test file's import already bound in this process.
  async function run(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        BEACHSIDE_TELEMETRY: "0",
        HOME: root,
        BEACHSIDE_CONFIG: join(root, "beachside.json"),
        BEACHSIDE_STATE_DIR: join(root, "state"),
        BEACHSIDE_FAKE_URL: server.url.origin,
        BEACHSIDE_FAKE_TOKEN: token,
        ...extra,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });

    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    return { code, json: JSON.parse(stdout) };
  }

  async function stored(): Promise<string[]> {
    return readdir(join(root, "state", "sandboxes")).catch(() => []);
  }

  test("refuses before creating anything when the key is missing", async () => {
    const result = await run(["create", "--name", "web", "--with", "rex", "--json"]);

    expect(result.code).toBe(2);
    expect(result.json.error.message).toContain("TAILSCALE_AUTH_KEY");
    expect(await stored()).toEqual([]);
  });

  test("refuses a network other than internet, and unknown servers", async () => {
    const env = { TAILSCALE_AUTH_KEY: "tskey-auth-x" };

    expect(
      (await run(["create", "--with", "rex", "--network", "blocked", "--json"], env)).code,
    ).toBe(2);
    expect((await run(["create", "--with", "orca", "--json"], env)).code).toBe(2);
    expect((await run(["create", "--with", "rex", "--snapshot", "base", "--json"], env)).code).toBe(
      2,
    );
    expect(await stored()).toEqual([]);
  });

  test("--if-not-exists refuses a sandbox that lacks the requested add-on", async () => {
    const env = { TAILSCALE_AUTH_KEY: "tskey-auth-x" };

    expect(
      (await run(["create", "--name", "plain", "--prepared", "fake-starter", "--json"])).code,
    ).toBe(0);

    const again = await run(
      ["create", "--name", "plain", "--if-not-exists", "--with", "rex", "--json"],
      env,
    );

    expect(again.json.error.code).toBe("CONFLICT");
    expect(again.json.error.message).toContain("has no ready rex");
  });
});
