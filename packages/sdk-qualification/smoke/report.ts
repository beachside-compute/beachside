import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const here = import.meta.dir;

const ProviderEntry = z.object({
  env: z.array(z.string()),
  secrets: z.array(z.string()),
  create: z.array(z.string()),
  labels: z.boolean(),
  exceptions: z.record(z.string(), z.string()),
});

const Providers = z.object({ providers: z.record(z.string(), ProviderEntry) });

export const smokeProviders = Providers.parse(
  JSON.parse(await readFile(join(here, "providers.json"), "utf8")),
).providers;

/** Every check, in report order. */
export const checkNames = [
  "doctor",
  "create",
  "inspect",
  "list",
  "env-create",
  "env-second-process",
  "env-child",
  "env-login",
  "env-odd-value",
  "env-per-command",
  "env-override",
  "file-roundtrip",
  "clock",
  "network",
  "install",
  "exit-code",
  "cwd",
  "stdin",
  "streaming",
  "timeout",
  "copy-tree",
  "push",
  "run",
  "rm",
  "no-leftovers",
] as const;

export type CheckName = (typeof checkNames)[number];

export const CheckStatus = z.enum(["pass", "fail", "unsupported", "restricted", "skipped"]);

export type CheckStatus = z.infer<typeof CheckStatus>;

export const SmokeReport = z.object({
  provider: z.string(),
  runId: z.string(),
  cli: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  checks: z.record(z.string(), z.object({ status: CheckStatus, detail: z.string() })),
  info: z.record(z.string(), z.string()),
  scrubHits: z.number(),
});

export type SmokeReport = z.infer<typeof SmokeReport>;
