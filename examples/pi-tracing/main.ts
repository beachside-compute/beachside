import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTextMapSetter, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { collectTraces, printTrace } from "./collector";
import { answer, answerName, endSpan, traceContext, tracing } from "./telemetry";

async function main() {
  const offline = process.argv.includes("--offline");

  const kilo = process.argv.includes("--kilo");

  if (offline && kilo) throw new Error("Choose either --offline or --kilo.");

  if (kilo && (!process.env.KILO_API_KEY || !process.env.DEFAULT_MODEL)) {
    throw new Error("Kilo requires DEFAULT_MODEL and KILO_API_KEY.");
  }

  if (!offline && !kilo && !process.env.PI_TRACING_MODEL) {
    throw new Error(
      "Set PI_TRACING_MODEL=provider/model-id for a live run, or use --kilo or --offline.",
    );
  }

  const runId = randomUUID();

  const collector =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? undefined
      : collectTraces();

  const telemetry = tracing("beachside-pi-demo", runId, offline, collector?.endpoint);
  const run = telemetry.start("demo.run", ROOT_CONTEXT);
  const parent = trace.setSpan(ROOT_CONTEXT, run);
  let cwd: string | undefined;
  let failed = true;

  try {
    cwd = await mkdtemp(join(await realpath(tmpdir()), "beachside-pi-"));
    const carrier = { traceparent: "", tracestate: "" };
    traceContext.inject(parent, carrier, defaultTextMapSetter);

    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./child.ts", import.meta.url)),
        ...process.argv.slice(2),
      ],
      {
        cwd,
        env: {
          ...process.env,
          TRACEPARENT: carrier.traceparent,
          TRACESTATE: carrier.tracestate,
          PI_TRACING_RUN_ID: runId,
          PI_TELEMETRY: "0",
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: collector
            ? "http/json"
            : process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL,
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
            collector?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        timeout: 90_000,
        killSignal: "SIGKILL",
      },
    );

    if ((await child.exited) !== 0) throw new Error("Pi child exited unsuccessfully.");

    const verification = telemetry.start("demo.verify", parent);
    let verificationFailed = true;

    try {
      if ((await readFile(join(cwd, answerName), "utf8")) !== answer) {
        throw new Error("Parent verification found incorrect contents in answer.txt.");
      }

      verificationFailed = false;
    } finally {
      endSpan(verification, verificationFailed);
    }

    failed = false;
  } finally {
    endSpan(run, failed);

    try {
      await telemetry.shutdown();
      console.log(
        `Run ${runId} (${offline ? "scripted model" : "live model"}), trace ${run.spanContext().traceId}`,
      );

      if (collector) printTrace(collector.spans, run.spanContext().spanId);
    } finally {
      if (collector) await collector.stop();

      if (cwd) await rm(cwd, { force: true, recursive: true });
    }
  }

  if (collector) {
    const { spanId, traceId } = run.spanContext();
    const spans = collector.spans.filter((span) => span.traceId === traceId);
    const agent = spans.find((span) => span.name === "pi.run" && span.parentSpanId === spanId);
    const agentSpans = spans.filter((span) => span.parentSpanId === agent?.spanId);

    if (
      !spans.some((span) => span.spanId === spanId) ||
      !spans.some((span) => span.name === "demo.verify" && span.parentSpanId === spanId) ||
      !agent ||
      !["pi.model", "pi.tool.write", "pi.tool.read"].every((name) =>
        agentSpans.some((span) => span.name === name && span.status.code === 1),
      )
    ) {
      throw new Error(
        "The local collector did not receive the expected run, model, tool, and verification spans.",
      );
    }
  }

  console.log('Parent verified answer.txt contains exactly "4\\n".');
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Pi tracing demo failed.");
    process.exitCode = 1;
  }
}
