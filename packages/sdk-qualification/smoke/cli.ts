import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Scrubber } from "./scrub";

/** One finished CLI invocation. Output is kept in memory only for parsing; logs are scrubbed. */
export type CliRun = {
  args: string[];
  code: number;
  stdout: Uint8Array;
  stderr: string;
  /** Milliseconds from start until the first stdout byte, or null when none arrived. */
  firstStdoutMs: number | null;
  elapsedMs: number;
};

const Envelope = z.union([
  z.object({ ok: z.literal(true), data: z.json() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }).passthrough(),
  }),
]);

export type Envelope = z.infer<typeof Envelope>;

/** Runs the `beachside` CLI one process per step, as a user or an agent would. */
export class Cli {
  private count = 0;

  constructor(
    /** The command that starts the CLI, such as ["bun", ".../main.ts"] or ["beachside"]. */
    readonly command: string[],
    readonly environment: Record<string, string>,
    readonly cwd: string,
    readonly logDirectory: string,
    readonly scrubber: Scrubber,
  ) {}

  async run(args: string[], stdin?: Uint8Array, timeoutMs = 300_000): Promise<CliRun> {
    const started = performance.now();
    let firstStdoutMs: number | null = null;

    const child = Bun.spawn([...this.command, ...args], {
      cwd: this.cwd,
      env: this.environment,
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });

    const chunks: Uint8Array[] = [];

    const reading = (async () => {
      const reader = child.stdout.getReader();

      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        firstStdoutMs ??= performance.now() - started;
        chunks.push(value);
      }
    })();

    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
      reading,
    ]);

    const stdout = Buffer.concat(chunks);

    const result = {
      args,
      code,
      stdout: new Uint8Array(stdout),
      stderr,
      firstStdoutMs,
      elapsedMs: performance.now() - started,
    };

    await this.log(result);

    return result;
  }

  /** Runs with --json and parses the single envelope the CLI prints. */
  async json(args: string[]): Promise<{ run: CliRun; envelope: Envelope }> {
    // Flags after `--` belong to the remote command, so --json goes before it.
    const split = args.indexOf("--");
    const run = await this.run(
      split < 0 ? [...args, "--json"] : [...args.slice(0, split), "--json", ...args.slice(split)],
    );
    const text = new TextDecoder().decode(run.stdout).trim();
    const parsed = Envelope.safeParse(JSON.parse(text || "null"));

    if (!parsed.success)
      throw new Error(
        `beachside ${args[0]} printed no JSON envelope (exit ${run.code}): ${this.scrubber.scrub(run.stderr).slice(0, 500)}`,
      );

    return { run, envelope: parsed.data };
  }

  /** Every invocation is logged scrubbed, never raw, so a report or artifact cannot carry a key. */
  private async log(run: CliRun) {
    this.count += 1;
    await mkdir(this.logDirectory, { recursive: true });

    const text = [
      `$ beachside ${run.args.join(" ")}`,
      `exit ${run.code} after ${Math.round(run.elapsedMs)} ms`,
      "--- stdout",
      new TextDecoder().decode(run.stdout.slice(0, 64 * 1024)),
      "--- stderr",
      run.stderr.slice(0, 64 * 1024),
    ].join("\n");

    await writeFile(
      join(this.logDirectory, `${String(this.count).padStart(2, "0")}-${run.args[0]}.log`),
      this.scrubber.scrub(text),
      { mode: 0o600 },
    );
  }
}
