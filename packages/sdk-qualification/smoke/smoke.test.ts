/**
 * Provider smoke test: one provider per process, chosen with SMOKE_PROVIDER. It drives the real
 * `beachside` CLI one process per step, the way users and agents do, and checks the basics they
 * hit first. Ordinary `bun test` skips it. Run all providers with `bun run smoke`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { Cli, type CliRun } from "./cli";
import { Scrubber, secretValues } from "./scrub";
import {
  checkNames,
  smokeProviders,
  type CheckName,
  type CheckStatus,
  type SmokeReport,
} from "./report";

const provider = process.env.SMOKE_PROVIDER ?? "";

const enabled = provider !== "";

const here = import.meta.dir;

const root = resolve(here, "../../..");

const randomValue = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`;

// Spaces, both quotes, $, a backslash, = and non-ASCII: what an env file written without quoting
// breaks on. No newline, so the probe's key=value lines stay one per key.
const oddValue = `a b 'c' "d" $HOME \\x =e ü ${crypto.randomUUID().slice(0, 6)}`;

describe.skipIf(!enabled)(`provider smoke: ${provider}`, () => {
  const entry = smokeProviders[provider];
  const runId = process.env.SMOKE_RUN_ID ?? crypto.randomUUID().slice(0, 8);
  const name = `smoke-${runId}`;

  const reportDirectory = resolve(
    process.env.SMOKE_REPORT_DIR ?? join(tmpdir(), "beachside-smoke"),
  );

  const values = {
    create: randomValue("create"),
    call: randomValue("call"),
  };

  const startedAt = new Date().toISOString();
  const checks = new Map<CheckName, { status: CheckStatus; detail: string }>();
  const info = new Map<string, string>();
  const probe = new Map<string, string>();
  const scrubber = new Scrubber(secretValues(process.env, entry?.secrets ?? []));
  let cli: Cli;
  let work: string;
  let createdId: string | undefined;
  let created = false;
  let removed = false;
  let createEnv = true;

  const record = (check: CheckName, status: CheckStatus, detail = "") => {
    checks.set(check, { status, detail: scrubber.scrub(detail).slice(0, 400) });
  };

  /** One check: records pass or fail (or restricted when providers.json excuses it). */
  const check = (
    check: CheckName,
    body: () => Promise<void>,
    timeoutMs = 120_000,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Bun's own test signature.
  ) =>
    test(
      check,
      async () => {
        const preset = checks.get(check);

        // A check decided earlier (unsupported, or skipped because create failed) is reported as is.
        if (preset) return;

        try {
          await body();
          record(check, "pass");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const excuse = entry?.exceptions[check];

          record(check, excuse ? "restricted" : "fail", excuse ? `${excuse}: ${message}` : message);

          if (!excuse) throw new Error(scrubber.scrub(message));
        }
      },
      timeoutMs,
    );

  const text = (run: CliRun) => new TextDecoder().decode(run.stdout);

  const ok = (run: CliRun, what: string) => {
    if (run.code !== 0)
      throw new Error(`${what} exited ${run.code}: ${run.stderr.trim().slice(0, 300)}`);
  };

  beforeAll(async () => {
    if (!entry) throw new Error(`${provider} is not in smoke/providers.json`);

    work = await mkdtemp(join(tmpdir(), "beachside-smoke-"));

    const command = process.env.SMOKE_CLI
      ? process.env.SMOKE_CLI.split(" ")
      : ["bun", join(root, "packages/cli/src/main.ts")];

    const home = join(work, "home");

    // Only what the CLI needs: no ambient credentials for other providers, no user config.
    const environment = Object.fromEntries([
      ["PATH", process.env.PATH ?? ""],
      ["HOME", home],
      ["XDG_CONFIG_HOME", process.env.SMOKE_XDG_CONFIG_HOME ?? join(work, "config")],
      ["BEACHSIDE_CONFIG", process.env.SMOKE_CONFIG ?? join(here, "beachside.json")],
      ["BEACHSIDE_STATE_DIR", join(work, "state")],
      ["BEACHSIDE_PROFILE", provider],
      ["BEACHSIDE_TELEMETRY", "0"],
      ...entry.env.flatMap((variable) => {
        const value = process.env[variable];

        return value ? [[variable, value] as const] : [];
      }),
    ]);

    await mkdir(home, { recursive: true });
    cli = new Cli(command, environment, here, join(reportDirectory, provider), scrubber);

    const version = await cli.run(["--version"]);
    info.set("cli", text(version).trim());

    // Leftovers from runs that died: older than an hour, so a run in progress is never touched.
    if (entry.labels)
      await cli.run(["gc", "--label", "ci=beachside-smoke", "--older-than", "1h", "--json"]);

    const doctor = await cli.run(["doctor"]);

    if (doctor.code === 0) record("doctor", "pass");
    else record("doctor", "fail", doctor.stderr);

    const createArgs = (env: boolean) => [
      "create",
      "--name",
      name,
      "--label",
      "ci=beachside-smoke",
      "--label",
      `run=${runId}`,
      "--ttl",
      "15m",
      ...entry.create,
      ...(env
        ? [
            "--env",
            `SMOKE_CREATE=${values.create}`,
            "--env",
            `SMOKE_ODD=${oddValue}`,
            "--env",
            "SMOKE_BOTH=create",
          ]
        : []),
      // Our own CLI from npm, installed by a setup step and used by a later command.
      "--setup-cmd",
      'npm install -g --prefix "$HOME/.beachside-smoke" @beachside/cli',
      "--setup-timeout",
      "5m",
    ];

    let { run, envelope } = await cli.json(createArgs(true));

    if (
      !envelope.ok &&
      envelope.error.code === "UNSUPPORTED" &&
      /env/i.test(envelope.error.message)
    ) {
      createEnv = false;
      ({ run, envelope } = await cli.json(createArgs(false)));
    }

    // A failed setup step keeps the sandbox (exit 9), so every other check can still run.
    if (envelope.ok || run.code === 9) {
      created = true;
      const data = z.object({ id: z.string() }).safeParse(envelope.ok ? envelope.data : null);
      createdId = data.success ? data.data.id : undefined;
      record("create", "pass");

      if (run.code === 9)
        record("install", "fail", `setup step failed: ${run.stderr || "see log"}`);
    } else {
      record("create", "fail", `${envelope.error.code}: ${envelope.error.message}`);

      for (const name of checkNames)
        if (!checks.has(name)) record(name, "skipped", "create failed");

      return;
    }

    if (!createEnv)
      for (const check of [
        "env-create",
        "env-second-process",
        "env-child",
        "env-login",
        "env-odd-value",
        "env-override",
      ] as const)
        record(check, "unsupported", "the adapter refuses create-time env");

    const probePath = "/tmp/beachside-smoke-probe.sh";
    const copied = await cli.run(["cp", join(here, "probe.sh"), `${name}:${probePath}`]);

    if (copied.code !== 0) {
      info.set("probe", `cp failed: ${copied.stderr.trim().slice(0, 200)}`);

      return;
    }

    const result = await cli.run([
      "exec",
      name,
      "--env",
      `SMOKE_CALL=${values.call}`,
      "--env",
      "SMOKE_BOTH=call",
      "--",
      "sh",
      probePath,
      "/tmp/beachside-smoke.out",
    ]);

    if (result.code !== 0)
      info.set("probe", `exit ${result.code}: ${result.stderr.trim().slice(0, 200)}`);

    for (const line of text(result).split("\n")) {
      const at = line.indexOf("=");

      if (at > 0) probe.set(line.slice(0, at), line.slice(at + 1));
    }

    for (const key of ["user", "uid", "tools", "net_client", "net_status", "dns"])
      info.set(key, probe.get(key) ?? "-");
  }, 900_000);

  afterAll(async () => {
    if (!entry || !cli) return;

    try {
      if (created && !removed) await cli.run(["rm", name, "--force", "--json"]);

      if (entry.labels) await cli.run(["gc", "--label", `run=${runId}`, "--json"]);
    } finally {
      await mkdir(reportDirectory, { recursive: true });

      const report: SmokeReport = {
        provider,
        runId,
        cli: info.get("cli") ?? "",
        startedAt,
        finishedAt: new Date().toISOString(),
        checks: Object.fromEntries(
          checkNames.map((name) => [
            name,
            checks.get(name) ?? { status: "skipped", detail: "not reached" },
          ]),
        ),
        info: Object.fromEntries(info),
        scrubHits: scrubber.hits,
      };

      await writeFile(
        join(reportDirectory, `${provider}.json`),
        scrubber.scrub(JSON.stringify(report, null, 2)),
        { mode: 0o600 },
      );
      await rm(work, { recursive: true, force: true });
    }

    // A scrub hit means something tried to print a secret: fail so the key gets rotated.
    expect(scrubber.hits).toBe(0);
  }, 180_000);

  check("doctor", async () => {
    throw new Error("doctor result missing");
  });

  check("create", async () => {
    throw new Error("create result missing");
  });

  check("inspect", async () => {
    const { envelope } = await cli.json(["inspect", name]);

    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);

    const data = z
      .object({
        info: z.object({
          state: z.string(),
          expires: z.object({ status: z.string(), at: z.string().optional() }),
        }),
      })
      .parse(envelope.data);

    expect(data.info.state).toBe("running");
    expect(data.info.expires.status).toBe("known");
    const left = Date.parse(data.info.expires.at ?? "") - Date.now();

    // --ttl 15m, created a few minutes ago at most.
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(16 * 60 * 1000);
  });

  check("list", async () => {
    const { envelope } = await cli.json(["ls", "--remote"]);

    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);

    const rows = z
      .object({
        sandboxes: z.array(
          z.object({
            id: z.string(),
            state: z.string(),
            labels: z.record(z.string(), z.string()).nullable().optional(),
          }),
        ),
      })
      .parse(envelope.data).sandboxes;

    const row = rows.find((candidate) => candidate.id === createdId);

    expect(row?.state).toBe("running");

    // gc finds sandboxes only by their labels, so they must come back in the listing.
    if (entry?.labels) expect(row?.labels?.run).toBe(runId);
  });

  check("env-create", async () => {
    expect(probe.get("env_create")).toBe(values.create);
  });

  check("env-second-process", async () => {
    // A separate CLI process: env kept only by the first client, or only on the native main
    // process, is gone here.
    const run = await cli.run(["sh", name, 'printf %s "${SMOKE_CREATE:-}"']);
    ok(run, "sh");
    expect(text(run)).toBe(values.create);
  });

  check("env-child", async () => {
    expect(probe.get("env_child")).toBe(values.create);
  });

  check("env-login", async () => {
    expect(probe.get("env_login_sh")).toBe(values.create);

    if (probe.get("env_login_bash") !== "-")
      expect(probe.get("env_login_bash")).toBe(values.create);
  });

  check("env-odd-value", async () => {
    expect(probe.get("env_odd")).toBe(oddValue);
  });

  check("env-per-command", async () => {
    expect(probe.get("env_call")).toBe(values.call);
  });

  check("env-override", async () => {
    expect(probe.get("env_both")).toBe("call");
  });

  check("file-roundtrip", async () => {
    const local = join(work, "marker.out");
    ok(await cli.run(["cp", `${name}:/tmp/beachside-smoke.out`, local]), "cp back");
    const [value, epoch] = (await readFile(local, "utf8")).trim().split("|");

    expect(value).toBe(createEnv ? values.create : "");
    expect(Math.abs(Number(epoch) - Date.now() / 1000)).toBeLessThan(600);
  });

  check("clock", async () => {
    const skew = Math.round(Number(probe.get("epoch")) - Date.now() / 1000);
    info.set("clock_skew_s", String(skew));

    // The probe ran up to a few minutes ago; a guest clock off by more breaks TLS and tokens.
    expect(Math.abs(skew)).toBeLessThan(600);
  });

  check("network", async () => {
    expect(probe.get("net_status")).toMatch(/^[23]\d\d$/);
  });

  check("install", async () => {
    const latest = z
      .object({ version: z.string() })
      .parse(
        await (await fetch("https://registry.npmjs.org/@beachside/cli/latest")).json(),
      ).version;

    const run = await cli.run([
      "exec",
      name,
      "--",
      "sh",
      "-c",
      '"$HOME/.beachside-smoke/bin/beachside" --version',
    ]);

    ok(run, "installed beachside --version");
    expect(text(run).trim()).toBe(latest);
    info.set("installed_cli", latest);
  });

  check("exit-code", async () => {
    const run = await cli.run(["exec", name, "--", "sh", "-c", "echo out; echo err >&2; exit 3"]);

    expect(run.code).toBe(3);
    expect(text(run)).toBe("out\n");
    expect(run.stderr).toBe("err\n");
  });

  check("cwd", async () => {
    const run = await cli.run(["exec", name, "--cwd", "/tmp", "--", "pwd"]);
    ok(run, "pwd");
    expect(text(run).trim()).toBe("/tmp");
  });

  check("stdin", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 10, ...new TextEncoder().encode("smoke ü\n")]);
    const run = await cli.run(["exec", name, "--stdin", "--", "cat"], bytes);
    ok(run, "cat");
    expect(run.stdout).toEqual(bytes);
  });

  check("streaming", async () => {
    const run = await cli.run(["exec", name, "--", "sh", "-c", "echo first; sleep 8; echo last"]);
    ok(run, "streaming command");
    expect(text(run)).toBe("first\nlast\n");
    // The first line must arrive well before the command ends, not all at once at exit.
    expect(run.firstStdoutMs ?? Infinity).toBeLessThan(run.elapsedMs - 5000);
  });

  check("timeout", async () => {
    const run = await cli.run(["exec", name, "--timeout", "5s", "--", "sleep", "600"]);

    expect(run.code).toBe(125);
    expect(run.stderr).toContain("--timeout");
    expect(run.elapsedMs).toBeLessThan(60_000);
  });

  check(
    "copy-tree",
    async () => {
      const tree = join(work, "tree");
      await mkdir(join(tree, "nested"), { recursive: true });
      // 5 MiB of random bytes; getRandomValues fills at most 64 KiB per call.
      const big = new Uint8Array(5 * 1024 * 1024);

      for (let offset = 0; offset < big.length; offset += 65_536)
        big.set(crypto.getRandomValues(new Uint8Array(65_536)), offset);
      await writeFile(join(tree, "big.bin"), big);
      await writeFile(join(tree, "nested", "note.txt"), `note ${runId}\n`);

      ok(await cli.run(["cp", "-r", tree, `${name}:/tmp/beachside-smoke-tree`]), "cp -r up");
      const back = join(work, "back");
      ok(await cli.run(["cp", "-r", `${name}:/tmp/beachside-smoke-tree`, back]), "cp -r down");

      const paths = (await readdir(back, { recursive: true })).map((path) => join(back, path));
      const bigBack = paths.find((path) => path.endsWith("big.bin"));
      const noteBack = paths.find((path) => path.endsWith(join("nested", "note.txt")));

      expect(bigBack && new Uint8Array(await readFile(bigBack))).toEqual(big);
      expect(noteBack && (await readFile(noteBack, "utf8"))).toBe(`note ${runId}\n`);

      const cat = await cli.run(["cat", `${name}:/tmp/beachside-smoke-tree/nested/note.txt`]);

      if (cat.code === 0) expect(text(cat)).toBe(`note ${runId}\n`);
      else {
        // cp -r may nest the source directory under the target.
        const nested = await cli.run([
          "cat",
          `${name}:/tmp/beachside-smoke-tree/tree/nested/note.txt`,
        ]);

        ok(nested, "cat");
        expect(text(nested)).toBe(`note ${runId}\n`);
      }
    },
    240_000,
  );

  check("push", async () => {
    const project = join(work, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "hello.txt"), `push ${runId}\n`);
    ok(await cli.run(["push", `${name}:/tmp/beachside-smoke-push`, project]), "push");
    const run = await cli.run(["cat", `${name}:/tmp/beachside-smoke-push/hello.txt`]);
    ok(run, "cat pushed file");
    expect(text(run)).toBe(`push ${runId}\n`);
  });

  check(
    "run",
    async () => {
      const { run, envelope } = await cli.json([
        "run",
        "--label",
        "ci=beachside-smoke",
        "--label",
        `run=${runId}`,
        "--ttl",
        "10m",
        ...(entry?.create ?? []),
        "--",
        "sh",
        "-c",
        "echo one-shot",
      ]);

      if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
      expect(run.code).toBe(0);
      expect(envelope.data).toMatchObject({ stdout: "one-shot\n", sandbox: { kept: false } });
    },
    300_000,
  );

  check("rm", async () => {
    ok(await cli.run(["rm", name]), "rm");
    removed = true;

    const { envelope } = await cli.json(["ls", "--remote"]);

    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);

    const rows = z
      .object({ sandboxes: z.array(z.object({ id: z.string(), state: z.string() })) })
      .parse(envelope.data).sandboxes;

    const row = rows.find((candidate) => candidate.id === createdId);

    if (row) expect(["destroyed", "deleting", "stopping"]).toContain(row.state);
  });

  check("no-leftovers", async () => {
    if (!entry?.labels) return;

    const { envelope } = await cli.json(["gc", "--label", `run=${runId}`, "--dry-run"]);

    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    expect(z.object({ removed: z.array(z.unknown()) }).parse(envelope.data).removed).toEqual([]);
  });
});
