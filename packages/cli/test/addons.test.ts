import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
    // Host keys are made before tailscaled starts, so Tailscale serves keys whose .pub exists.
    const order = calls.map((call) => call.script);
    expect(order.findIndex((script) => script.includes("ssh-keygen -q"))).toBeLessThan(
      order.findIndex((script) => script.includes("setsid -f tailscaled")),
    );
  });

  test("herdr: names the machine after the sandbox only when herdr-core accepts the name", async () => {
    async function connect(sandbox: string) {
      const { shell } = scriptedShell([
        [/status --json/, { stdout: `ubuntu\n{"Self":{"DNSName":"beachside-x.tail1.ts.net."}}` }],
      ]);

      const result = await setupAddons(
        shell,
        sandbox,
        ["herdr"],
        key,
        AbortSignal.timeout(10_000),
        quietOutput(),
        async () => {},
      );

      return result.addons[0]!.connect;
    }

    expect(await connect("t12ab")).toEndWith("--install --name t12ab");
    // Shaped like a terminal id, or longer than 32: hc picks the name from the host instead.
    expect(await connect("t14")).toEndWith("--temp --install");
    expect(await connect("t1b")).toEndWith("--temp --install");
    expect(await connect("a".repeat(33))).toEndWith("--temp --install");
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

  test("host key fingerprints match ssh-keygen -l, for keys, .pub lines and known_hosts lines", () => {
    expect(hostKeyFingerprint(fixtureKey)).toBe(fixtureFingerprint);
    expect(hostKeyFingerprint(`${fixtureKey} root@fixture`)).toBe(fixtureFingerprint);
    expect(hostKeyFingerprint(`beachside-web.tail1.ts.net ${fixtureKey}`)).toBe(fixtureFingerprint);
    expect(hostKeyFingerprint(`beachside-web.tail1.ts.net ${fixtureKey} a comment`)).toBe(
      fixtureFingerprint,
    );
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

  test("rm and gc name the herdr-core machine whose target is this sandbox", () => {
    const ready: AddonRecord = {
      name: "herdr",
      hostname: "beachside-web",
      state: "ready",
      connect: "hc machine add ubuntu@beachside-web.tail1.ts.net --temp --install --name web",
    };

    const target = "ubuntu@beachside-web.tail1.ts.net";

    // `web` was taken by another machine, so herdr-core called this one web-2.
    expect(
      removedAddonNotes(
        "web",
        [ready],
        [
          { name: "web", target: "me@web.example.com" },
          { name: "web-2", target },
        ],
      ),
    ).toEqual(["herdr: forget web in Herdr with `hc machine rm web-2`"]);
    // Never added here: nothing to forget.
    expect(
      removedAddonNotes("web", [ready], [{ name: "web", target: "me@web.example.com" }]),
    ).toEqual([]);
    // No hc to ask: say how to find the name, never guess it.
    expect(removedAddonNotes("web", [ready], null)).toEqual([
      `herdr: if you added web to Herdr, forget it with \`hc machine rm <name>\`, using the name \`hc machine ls\` shows for ${target}`,
    ]);
    expect(removedAddonNotes("web", [{ ...ready, state: "failed" }], null)).toEqual([]);
    expect(removedAddonNotes("web", [], null)).toEqual([]);
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

const sshKeygen = Bun.which("ssh-keygen");

// The host-key scripts as a sandbox runs them: /etc/ssh and $HOME point into a temp folder, sudo
// just runs its command, and PATH holds only the tools a test allows.
describe.skipIf(!sshKeygen)("herdr host keys in a shell", () => {
  async function herdrScripts() {
    const { shell, calls } = scriptedShell([
      [/status --json/, { stdout: `ubuntu\n{"Self":{"DNSName":"beachside-web.tail1.ts.net."}}` }],
    ]);

    await setupAddons(
      shell,
      "web",
      ["herdr"],
      "tskey-test",
      AbortSignal.timeout(10_000),
      quietOutput(),
      async () => {},
    );

    return {
      prepare: calls.find((call) => call.script.includes("ssh-keygen -q"))!.script,
      read: calls.find((call) => call.script.includes('cat "$k.pub"'))!.script,
    };
  }

  async function inSandbox(
    options: { keygen: boolean; system?: (dir: string) => void },
    check: (result: { prepare: number; read: string; state: string; system: string }) => void,
  ) {
    const root = await mkdtemp(join(tmpdir(), "beachside-hostkeys-"));
    const home = join(root, "home");
    const system = join(root, "etc-ssh");
    const bin = join(root, "bin");

    try {
      for (const dir of [home, system, bin]) await mkdir(dir, { recursive: true });
      await writeFile(join(bin, "sudo"), `#!/bin/sh\nshift\nexec "$@"\n`, { mode: 0o755 });

      for (const tool of ["mkdir", "cat", "test", ...(options.keygen ? ["ssh-keygen"] : [])])
        await symlink(Bun.which(tool)!, join(bin, tool));
      options.system?.(system);

      const { prepare, read } = await herdrScripts();

      const sh = (script: string) =>
        Bun.spawnSync(["/bin/sh", "-c", script.replaceAll("/etc/ssh", system)], {
          env: { PATH: bin, HOME: home },
        });

      const prepared = sh(prepare);
      const keys = sh(read);

      expect(keys.exitCode).toBe(0);
      check({
        prepare: prepared.exitCode,
        read: keys.stdout.toString(),
        state: join(home, ".local/state/beachside/tailscale/ssh"),
        system,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const keygenFingerprint = (pub: string) =>
    Bun.spawnSync([sshKeygen!, "-lf", pub]).stdout.toString().split(" ")[1];

  test("makes each missing type with its .pub before tailscaled starts, and reads them back", async () => {
    await inSandbox({ keygen: true }, ({ prepare, read, state }) => {
      expect(prepare).toBe(0);
      const lines = read.trim().split("\n");

      expect(lines.map((line) => line.split(" ")[0])).toEqual([
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ssh-rsa",
      ]);
      // The fingerprint `create` prints is the one ssh-keygen (and so ssh) computes.
      expect(hostKeyFingerprint(lines[0]!)).toBe(
        keygenFingerprint(join(state, "ssh_host_ed25519_key.pub")),
      );
    });
  }, 30_000);

  test("leaves a type to the system key in /etc/ssh, which Tailscale prefers", async () => {
    await inSandbox(
      {
        keygen: true,
        system: (dir) => {
          Bun.spawnSync([
            sshKeygen!,
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-C",
            "system",
            "-f",
            join(dir, "ssh_host_ed25519_key"),
          ]);
        },
      },
      ({ read, state, system }) => {
        const ed25519 = read.split("\n").find((line) => line.startsWith("ssh-ed25519"))!;

        expect(hostKeyFingerprint(ed25519)).toBe(
          keygenFingerprint(join(system, "ssh_host_ed25519_key.pub")),
        );
        expect(Bun.spawnSync(["test", "-e", join(state, "ssh_host_ed25519_key")]).exitCode).toBe(1);
      },
    );
  }, 30_000);

  test("without ssh-keygen it makes and reads nothing, and setup goes on", async () => {
    await inSandbox({ keygen: false }, ({ prepare, read }) => {
      expect(prepare).toBe(0);
      expect(read).toBe("");
    });
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
