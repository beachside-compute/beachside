import { randomUUID } from "node:crypto";
import { boxd } from "@beachside/boxd";
import { context, defaultTextMapSetter, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Beachside, BeachsideError, SandboxCleanupError } from "beachside";
import type { SandboxHandle } from "beachside";
import { gatewayConfig, selectedGateway } from "./gateway";
import type { Gateway } from "./gateway";
import { answer, answerName, endSpan, traceContext, tracing } from "./telemetry";

const workdir = "/tmp/beachside-pi";

const image = "docker.io/oven/bun:1.3.14-debian";

const guestDependencies = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@opentelemetry/api",
  "@opentelemetry/core",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-trace-base",
];

const forwarded = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
];

function required(name: string) {
  const value = process.env[name]?.trim();

  if (!value) throw new Error(`Set ${name} before starting the Boxd example.`);

  return value;
}

export function guestEnvironment(
  parent: Context,
  runId: string,
  sandboxId: string,
  host: Record<string, string | undefined>,
  gateway?: Gateway,
) {
  const carrier = { traceparent: "", tracestate: "" };
  traceContext.inject(parent, carrier, defaultTextMapSetter);

  const env = {
    TRACEPARENT: carrier.traceparent,
    TRACESTATE: carrier.tracestate,
    PI_TRACING_RUN_ID: runId,
    PI_TRACING_SANDBOX_ID: sandboxId,
    PI_TELEMETRY: "0",
  };

  if (gateway) {
    const config = gatewayConfig(gateway, host);
    Object.assign(env, {
      DEFAULT_MODEL: config.modelId,
      [config.keyName]: host[config.keyName],
    });

    if (gateway === "openrouter") Object.assign(env, { OPENROUTER_BASE_URL: config.baseUrl });
  }

  for (const name of forwarded) {
    const value = host[name];

    if (value) Object.assign(env, { [name]: value });
  }

  return env;
}

async function uploadRuntime(sandbox: SandboxHandle, signal: AbortSignal) {
  const manifest: { dependencies: Record<string, string> } = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();

  const dependencies = Object.fromEntries(
    guestDependencies.map((name) => [name, manifest.dependencies[name]]),
  );

  await sandbox.writeTextFile(
    `${workdir}/package.json`,
    JSON.stringify({ private: true, type: "module", dependencies }),
    { signal, maxBytes: 1_048_576, overwrite: true },
  );

  for (const file of ["child.ts", "telemetry.ts", "gateway.ts"]) {
    const bytes = await Bun.file(new URL(file, import.meta.url)).bytes();
    await sandbox.writeFile(`${workdir}/${file}`, bytes, {
      signal,
      maxBytes: 1_048_576,
      overwrite: true,
    });
  }
}

async function exec(
  sandbox: SandboxHandle,
  argv: string[],
  cwd: string,
  stage: string,
  signal: AbortSignal,
  env?: Record<string, string>,
) {
  const result = await sandbox.exec(
    {
      command: { kind: "argv", argv },
      cwd,
      env,
      deadlineSeconds: 120,
      maxOutputBytes: 16_384,
    },
    { signal },
  );

  if (result.exitCode !== 0 || result.truncated) {
    throw new Error(`Boxd ${stage} failed (exit ${result.exitCode}).`);
  }
}

export function openTraceContext() {
  const manager = new AsyncLocalStorageContextManager().enable();

  if (!context.setGlobalContextManager(manager)) {
    manager.disable();
    throw new Error("Could not register async tracing context.");
  }

  return () => {
    context.disable();
    manager.disable();
  };
}

async function main() {
  const apiKey = required("BOXD_API_KEY");
  const org = required("BOXD_ORG");

  if (process.argv.includes("--offline")) throw new Error("Boxd requires --kilo or --openrouter.");

  const gateway = selectedGateway(process.argv) ?? "kilo";
  const config = gatewayConfig(gateway, process.env);

  const endpoint = new URL(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || required("OTEL_EXPORTER_OTLP_ENDPOINT"),
  );

  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new Error("Set an HTTPS OTLP endpoint reachable from the Boxd sandbox.");
  }

  const runId = randomUUID();
  const closeContext = openTraceContext();

  const telemetry = tracing("beachside-pi-demo", runId, false);
  const run = telemetry.start("sandbox.run", ROOT_CONTEXT);
  const parent = trace.setSpan(ROOT_CONTEXT, run);
  let failed = true;
  let sandboxId: string | undefined;
  const interrupt = new AbortController();
  const stop = () => interrupt.abort();
  const signal = AbortSignal.any([interrupt.signal, AbortSignal.timeout(480_000)]);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await context.with(parent, async () => {
      const client = await Beachside.connect(
        boxd({
          apiKey,
          org,
          region: process.env.BOXD_REGION?.trim() || undefined,
          image,
          lifecycle: { lifetimeSeconds: 600 },
          resources: { vcpus: 1, memoryMiB: 4096 },
          preview: { access: "protected" },
          network: { allow: ["registry.npmjs.org", config.hostname, endpoint.hostname] },
        }),
        { tracing: { tracerProvider: telemetry.provider }, signal },
      );

      try {
        await client.sandboxes.with(
          { labels: { "beachside.demo.run": runId } },
          async (sandbox) => {
            sandboxId = sandbox.id;
            run.setAttribute("demo.sandbox.id", sandbox.id);
            console.log(`Created Boxd sandbox ${sandbox.id} for run ${runId}`);
            await exec(sandbox, ["mkdir", "-m", "700", workdir], "/tmp", "workspace setup", signal);
            console.log("Uploading Pi source and dependency manifest.");
            await uploadRuntime(sandbox, signal);
            console.log("Installing pinned Pi dependencies in Boxd.");
            await exec(
              sandbox,
              ["/usr/local/bin/bun", "install", "--ignore-scripts"],
              workdir,
              "dependency installation",
              signal,
            );
            console.log(`Running Pi in Boxd through ${config.name}.`);
            await exec(
              sandbox,
              ["/usr/local/bin/bun", "--no-env-file", "child.ts", `--${gateway}`],
              workdir,
              "Pi run",
              signal,
              guestEnvironment(parent, runId, sandbox.id, process.env, gateway),
            );

            console.log("Reading answer.txt through Beachside.");
            const verification = telemetry.start("demo.verify", parent);
            verification.setAttribute("demo.sandbox.id", sandbox.id);

            let verificationFailed = true;

            try {
              if (
                (await sandbox.readTextFile(`${workdir}/${answerName}`, {
                  signal,
                  maxBytes: 1024,
                })) !== answer
              ) {
                throw new Error("Parent verification found incorrect contents in answer.txt.");
              }

              verificationFailed = false;
            } finally {
              endSpan(verification, verificationFailed);
            }
          },
          { signal, cleanupTimeoutMs: 30_000 },
        );
      } finally {
        await client.close();
      }
    });

    failed = false;
  } finally {
    endSpan(run, failed);

    try {
      await telemetry.shutdown();
    } finally {
      closeContext();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      console.log(
        `Run ${runId}, trace ${run.spanContext().traceId}${sandboxId ? `, sandbox ${sandboxId}` : ""}`,
      );
    }
  }

  console.log('Parent verified answer.txt contains exactly "4\\n". Boxd sandbox destroyed.');
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof SandboxCleanupError) {
      console.error(`Boxd cleanup was not confirmed for sandbox ${error.sandboxId}.`);
    } else if (error instanceof BeachsideError) {
      console.error(`Beachside operation failed (${error.code}).`);

      const { outcome, reference } = error;

      const sandboxId =
        (outcome?.kind === "create" ? outcome.sandbox.nativeId : undefined) ??
        reference?.sandboxReference?.nativeId ??
        reference?.sandboxId;

      if (sandboxId) console.error(`Boxd sandbox ID from the failed operation ${sandboxId}.`);

      if (reference) {
        console.error(
          `Beachside ${reference.kind} operation ${reference.operationId}, submission ${reference.submissionId}.`,
        );
      }

      if (error.code === "OUTCOME_UNKNOWN" && reference?.kind === "create") {
        console.error(
          "Check Boxd inventory for the beachside.demo.run label using the run ID above before retrying.",
        );
      }
    } else {
      console.error(error instanceof Error ? error.message : "Boxd tracing demo failed.");
    }

    process.exitCode = 1;
  }
}
