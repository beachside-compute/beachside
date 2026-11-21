/**
 * Runs the provider smoke test for every supported provider in parallel and prints one grid.
 *
 *   bun run smoke                                  all providers, CLI built from this checkout
 *   bun run smoke -- --provider boxd,e2b           a subset
 *   bun run smoke -- --cli-version 0.19.0          a released CLI from npm instead
 *   bun run smoke -- --env-file ~/.config/x.env    keys from another file
 *
 * Keys come from the environment, then from --env-file (default ~/.config/beachside.env). Every
 * log and report is scrubbed of them; nothing raw is printed.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { checkNames, smokeProviders, SmokeReport, type CheckStatus } from "./report";
import { Scrubber, secretValues } from "./scrub";

const root = resolve(import.meta.dir, "../../..");

const { values: flags } = parseArgs({
  options: {
    provider: { type: "string" },
    report: { type: "string" },
    "env-file": { type: "string" },
    "cli-version": { type: "string" },
    "no-build": { type: "boolean" },
  },
});

const environment = { ...process.env };

const envFile = flags["env-file"] ?? join(homedir(), ".config", "beachside.env");

if (existsSync(envFile))
  for (const [key, value] of Object.entries(parseEnv(await readFile(envFile, "utf8"))))
    environment[key] ??= value;

const selected = flags.provider ? flags.provider.split(",") : Object.keys(smokeProviders);

for (const provider of selected)
  if (!smokeProviders[provider]) throw new Error(`Unknown provider ${provider}`);

const allSecrets = selected.flatMap((provider) =>
  secretValues(environment, smokeProviders[provider]?.secrets ?? []),
);

const scrubber = new Scrubber(allSecrets);

const runId = crypto.randomUUID().slice(0, 8);

const reportDirectory = resolve(
  flags.report ??
    join(tmpdir(), `beachside-smoke-${new Date().toISOString().slice(0, 10)}-${runId}`),
);

await mkdir(reportDirectory, { recursive: true, mode: 0o700 });

async function sh(command: string[], cwd = root, env = environment) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  if (code !== 0)
    throw new Error(
      `${command.join(" ")} failed (${code}): ${scrubber.scrub(stderr).slice(-2000)}`,
    );

  return stdout;
}

const cliEnvironment = new Map<string, string>();

if (flags["cli-version"]) {
  // A released CLI exactly as users install it, with each adapter added from npm.
  const prefix = await mkdtemp(join(tmpdir(), "beachside-smoke-cli-"));
  const config = join(prefix, "config");
  await sh(["npm", "install", "--prefix", prefix, `@beachside/cli@${flags["cli-version"]}`]);
  const bin = join(prefix, "node_modules", ".bin", "beachside");

  for (const provider of selected)
    await sh([bin, "adapter", "add", `${provider}@${flags["cli-version"]}`], root, {
      ...environment,
      XDG_CONFIG_HOME: config,
      BEACHSIDE_TELEMETRY: "0",
    });
  cliEnvironment.set("SMOKE_CLI", bin);
  cliEnvironment.set("SMOKE_XDG_CONFIG_HOME", config);
} else if (!flags["no-build"]) {
  console.log("Building packages from this checkout...");
  await sh(["bun", "run", "build:packages"]);
}

console.log(`Run ${runId}: ${selected.join(", ")}. Reports in ${reportDirectory}`);

const outcomes = await Promise.all(
  selected.map(async (provider) => {
    const entry = smokeProviders[provider]!;

    const missing = entry.env.filter((name) => !environment[name]);

    if (missing.length) return { provider, missing };

    // Each child sees only its own provider's keys, never the others'.
    const others = new Set(
      selected.flatMap((other) => (other === provider ? [] : smokeProviders[other]!.env)),
    );

    const own = Object.fromEntries(
      Object.entries(environment).filter(([key]) => !others.has(key) || entry.env.includes(key)),
    );

    const junit = join(reportDirectory, `${provider}.junit.xml`);

    const child = Bun.spawn(
      [
        "bun",
        "test",
        join(import.meta.dir, "smoke.test.ts"),
        "--reporter=junit",
        `--reporter-outfile=${junit}`,
      ],
      {
        cwd: root,
        env: {
          ...own,
          ...Object.fromEntries(cliEnvironment),
          SMOKE_PROVIDER: provider,
          SMOKE_RUN_ID: runId,
          SMOKE_REPORT_DIR: reportDirectory,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    await writeFile(
      join(reportDirectory, `${provider}.bun-test.log`),
      scrubber.scrub(`${stdout}\n${stderr}`),
      { mode: 0o600 },
    );

    // JUnit quotes failure messages, so it is scrubbed like every other artifact.
    if (existsSync(junit))
      await writeFile(junit, scrubber.scrub(await readFile(junit, "utf8")), { mode: 0o600 });
    console.log(`${provider}: finished (bun test exit ${code})`);

    return { provider, missing };
  }),
);

const symbol: Record<CheckStatus, string> = {
  pass: "pass",
  fail: "FAIL",
  unsupported: "unsupported",
  restricted: "restricted",
  skipped: "-",
};

const reports = new Map<string, SmokeReport>();

for (const { provider } of outcomes) {
  const path = join(reportDirectory, `${provider}.json`);

  if (existsSync(path))
    reports.set(provider, SmokeReport.parse(JSON.parse(await readFile(path, "utf8"))));
}

const header = ["check", ...outcomes.map(({ provider }) => provider)];

const rows = checkNames.map((check) => [
  check,
  ...outcomes.map(({ provider, missing }) => {
    if (missing.length) return "no keys";
    const result = reports.get(provider)?.checks[check];

    return result ? symbol[result.status] : "no report";
  }),
]);

const infoKeys = [
  "cli",
  "user",
  "tools",
  "net_client",
  "net_status",
  "clock_skew_s",
  "expires",
  "probe",
];

const infoRows = infoKeys.map((key) => [
  key,
  ...outcomes.map(({ provider }) => reports.get(provider)?.info[key] ?? ""),
]);

const table = (lines: string[][]) =>
  [lines[0]!, lines[0]!.map(() => "---"), ...lines.slice(1)]
    .map((line) => `| ${line.join(" | ")} |`)
    .join("\n");

const failures = [...reports.values()].flatMap((report) =>
  Object.entries(report.checks).flatMap(([check, result]) =>
    result.status === "fail" ? [`- ${report.provider} ${check}: ${result.detail}`] : [],
  ),
);

const markdown = scrubber.scrub(
  [
    `## Provider smoke ${runId}`,
    "",
    table([header, ...rows]),
    "",
    table([["", ...header.slice(1)], ...infoRows]),
    "",
    ...(failures.length ? ["### Failures", "", ...failures, ""] : []),
  ].join("\n"),
);

await writeFile(join(reportDirectory, "matrix.md"), markdown, { mode: 0o600 });

await writeFile(
  join(reportDirectory, "matrix.json"),
  scrubber.scrub(JSON.stringify([...reports.values()], null, 2)),
  { mode: 0o600 },
);

console.log(`\n${markdown}`);

if (process.env.GITHUB_STEP_SUMMARY)
  await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });

const scrubHits =
  scrubber.hits + [...reports.values()].reduce((sum, report) => sum + report.scrubHits, 0);

if (scrubHits)
  console.log(`\n${scrubHits} secret-shaped strings were redacted; rotate the keys used.`);

const failed =
  failures.length > 0 ||
  scrubHits > 0 ||
  outcomes.some(({ provider, missing }) => !missing.length && !reports.has(provider));

process.exit(failed ? 1 : 0);
