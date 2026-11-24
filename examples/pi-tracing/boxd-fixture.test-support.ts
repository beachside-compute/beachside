import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { Beachside, Image } from "beachside";
import { fixtureAdapter } from "../../packages/sdk-qualification/observability/adapter";
import { boxdTelemetry, guestEnvironment, openTraceContext } from "./boxd";
import { answer, endSpan } from "./telemetry";

const fix = fixtureAdapter({ exitCode: 0, read: async () => new TextEncoder().encode(answer) });

const closeContext = openTraceContext();

const runId = "boxd-trace-fixture";

const telemetry = boxdTelemetry(runId, true);

const run = telemetry.start("sandbox.run", ROOT_CONTEXT);

const parent = trace.setSpan(ROOT_CONTEXT, run);

const cwd = await mkdtemp(join(await realpath(tmpdir()), "beachside-pi-test-"));

let failed = true;

try {
  await context.with(parent, async () => {
    const client = await Beachside.connect({
      adapter: fix.adapter,
      credentials: {},
      config: {},
      ...telemetry.options,
    });

    try {
      await client.sandboxes.with({ environment: Image.prepared("fixture") }, async (sandbox) => {
        run.setAttribute("demo.sandbox.id", sandbox.id);
        await sandbox.writeTextFile("/tmp/fixture", "setup");

        await sandbox.exec({ command: { kind: "argv", argv: ["fixture"] }, maxOutputBytes: 1024 });

        const child = Bun.spawn(
          [process.execPath, fileURLToPath(new URL("./child.ts", import.meta.url)), "--offline"],
          {
            cwd,
            env: guestEnvironment(parent, runId, sandbox.id, process.env),
            stdout: "ignore",
            stderr: "inherit",
            timeout: 8_000,
          },
        );

        if ((await child.exited) !== 0) throw new Error("Fixture Pi child failed.");

        if ((await sandbox.readTextFile("/tmp/answer.txt")) !== answer) {
          throw new Error("Fixture Beachside read failed.");
        }
      });
    } finally {
      await client.close();
    }
  });

  if (fix.counts.destroy !== 1) throw new Error("Fixture sandbox destruction was not called.");

  failed = false;
} finally {
  endSpan(run, failed);

  try {
    await telemetry.shutdown();
  } finally {
    closeContext();
    await rm(cwd, { recursive: true, force: true });
  }
}
