import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTraceState, ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { guestEnvironment } from "./boxd";
import { gatewayConfig, registerGatewayModel, selectedGateway } from "./gateway";
import { collectTraces } from "./collector";

function entrypoint(name: string) {
  return fileURLToPath(new URL(name, import.meta.url));
}

describe("cross-process Pi tracing", () => {
  test("exports the complete scripted Pi trace before the parent exits", async () => {
    const receiver = collectTraces();

    try {
      const child = Bun.spawn([process.execPath, entrypoint("main.ts"), "--offline"], {
        env: {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.endpoint,
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        },
        stdout: "pipe",
        stderr: "inherit",
        timeout: 10_000,
      });

      const stdout = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(stdout).toContain('Parent verified answer.txt contains exactly "4\\n".');

      const { spans } = receiver;
      expect(spans.map((span) => span.name).sort()).toEqual([
        "demo.run",
        "demo.verify",
        "pi.model",
        "pi.model",
        "pi.model",
        "pi.run",
        "pi.tool.read",
        "pi.tool.write",
      ]);
      const root = spans.find((span) => span.name === "demo.run");
      const agent = spans.find((span) => span.name === "pi.run");

      if (!root || !agent) throw new Error("Missing run spans.");
      expect(root.parentSpanId || "").toBe("");
      expect(root.service).toBe("beachside-pi-demo");
      expect(agent.service).toBe("beachside-pi-agent");
      expect(agent.parentSpanId).toBe(root.spanId);
      const runId = root.attributes.find(({ key }) => key === "demo.run.id")?.value.stringValue;
      expect(runId).toMatch(/^[a-f0-9-]{36}$/);
      expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);

      for (const span of spans) {
        expect(span.traceId).toBe(root.traceId);
        expect(span.status.code).toBe(1);
        expect(span.attributes.find(({ key }) => key === "demo.run.id")?.value.stringValue).toBe(
          runId,
        );
        expect(span.attributes.find(({ key }) => key === "demo.mode")?.value.stringValue).toBe(
          "scripted",
        );

        if (span.name === "demo.verify") expect(span.parentSpanId).toBe(root.spanId);

        if (span.name.startsWith("pi.model") || span.name.startsWith("pi.tool.")) {
          expect(span.parentSpanId).toBe(agent.spanId);
          expect(span.service).toBe(agent.service);
        }
      }
    } finally {
      await receiver.stop();
    }
  });

  test("flushes a failed child span with the remote traceparent and tracestate", async () => {
    const receiver = collectTraces();
    const cwd = await mkdtemp(join(await realpath(tmpdir()), "beachside-pi-test-"));

    try {
      const traceId = "11111111111111111111111111111111";
      const parentSpanId = "2222222222222222";

      const child = Bun.spawn([process.execPath, entrypoint("child.ts")], {
        cwd,
        env: {
          TRACEPARENT: `00-${traceId}-${parentSpanId}-01`,
          TRACESTATE: "demo=value",
          PI_TRACING_RUN_ID: "failure-test",
          PI_CODING_AGENT_DIR: cwd,
          PI_TRACING_MODEL: "missing/model",
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.endpoint,
          OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
        },
        stdout: "ignore",
        stderr: "ignore",
        timeout: 10_000,
      });

      expect(await child.exited).toBe(1);
      expect(receiver.spans).toHaveLength(1);
      expect(receiver.spans[0]).toMatchObject({
        name: "pi.run",
        traceId,
        parentSpanId,
        traceState: "demo=value",
        status: { code: 2 },
      });
    } finally {
      await receiver.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  test("defaults to HTTP protobuf and passes configured OTLP headers from both processes", async () => {
    const batches: Buffer[] = [];

    const requests: { path: string; contentType: string | null; authorization: string | null }[] =
      [];

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          contentType: request.headers.get("content-type"),
          authorization: request.headers.get("authorization"),
        });
        batches.push(Buffer.from(await request.arrayBuffer()));

        return new Response(null, { headers: { "content-type": "application/x-protobuf" } });
      },
    });

    try {
      const parent = Bun.spawn([process.execPath, entrypoint("main.ts"), "--offline"], {
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: new URL("/otlp", server.url).href,
          OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20Zml4dHVyZQ==",
        },
        stdout: "ignore",
        stderr: "inherit",
        timeout: 10_000,
      });

      expect(await parent.exited).toBe(0);
      expect(requests).toEqual(
        Array.from({ length: 2 }, () => ({
          path: "/otlp/v1/traces",
          contentType: "application/x-protobuf",
          authorization: "Basic Zml4dHVyZQ==",
        })),
      );
      expect(batches[0].includes("pi.tool.read")).toBe(true);
      expect(batches[1].includes("demo.verify")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
  test("fails safely when the OTLP endpoint rejects both processes' exports", async () => {
    let requests = 0;

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;

        return new Response("fixture receiver detail", { status: 401 });
      },
    });

    try {
      const parent = Bun.spawn([process.execPath, entrypoint("main.ts"), "--offline"], {
        env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: new URL("/v1/traces", server.url).href },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });

      const [stdout, stderr] = await Promise.all([
        new Response(parent.stdout).text(),
        new Response(parent.stderr).text(),
      ]);

      expect(await parent.exited).toBe(1);
      expect(requests).toBe(2);
      expect(stdout).not.toContain("Parent verified");
      expect(stderr).toContain("OTLP export failed for beachside-pi-agent.");
      expect(stderr).toContain("OTLP export failed for beachside-pi-demo.");
      expect(stderr).not.toContain("fixture receiver detail");
    } finally {
      await server.stop(true);
    }
  });

  test("requires Kilo credentials and a model before starting the live child", async () => {
    const parent = Bun.spawn([process.execPath, "--no-env-file", entrypoint("main.ts"), "--kilo"], {
      env: { DEFAULT_MODEL: "kilo-auto/custom/example" },
      stdout: "ignore",
      stderr: "pipe",
      timeout: 10_000,
    });

    const stderr = await new Response(parent.stderr).text();

    expect(await parent.exited).toBe(1);
    expect(stderr).toContain("Kilo requires DEFAULT_MODEL and KILO_API_KEY.");
  });
});

test("the Boxd Pi command receives only its explicit trace, selected gateway and OTLP variables", () => {
  const parent = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: TraceFlags.SAMPLED,
    traceState: createTraceState("demo=value"),
  });

  const host = {
    DEFAULT_MODEL: "openai/gpt-4.1-mini",
    OPENROUTER_API_KEY: "fixture-openrouter",
    OPENROUTER_BASE_URL: "https://fixture.example/gateway/openrouter",
    KILO_API_KEY: "must-stay-on-host",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://fixture.example/otlp",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=fixture",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    BOXD_API_KEY: "must-stay-on-host",
    unrelated: "must-stay-on-host",
    TRACEPARENT: "ignored",
  };

  const env = guestEnvironment(parent, "owned-run", "owned-sandbox", host, "openrouter");

  expect<Record<string, string>>(env).toEqual({
    TRACEPARENT: "00-11111111111111111111111111111111-2222222222222222-01",
    TRACESTATE: "demo=value",
    PI_TRACING_RUN_ID: "owned-run",
    PI_TRACING_SANDBOX_ID: "owned-sandbox",
    PI_TELEMETRY: "0",
    DEFAULT_MODEL: "openai/gpt-4.1-mini",
    OPENROUTER_API_KEY: "fixture-openrouter",
    OPENROUTER_BASE_URL: "https://fixture.example/gateway/openrouter",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://fixture.example/otlp",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=fixture",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  });

  const kilo = guestEnvironment(parent, "owned-run", "owned-sandbox", host, "kilo");
  expect(kilo).toHaveProperty("KILO_API_KEY");
  expect(kilo).not.toHaveProperty("OPENROUTER_API_KEY");
  expect(kilo).not.toHaveProperty("OPENROUTER_BASE_URL");
});

test("Beachside SDK operations and Pi's subprocess export share the sandbox root trace", async () => {
  const receiver = collectTraces();

  try {
    const fixture = Bun.spawn([process.execPath, entrypoint("boxd-fixture.test-support.ts")], {
      env: {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.endpoint,
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/json",
      },
      stdout: "ignore",
      stderr: "inherit",
      timeout: 10_000,
    });

    expect(await fixture.exited).toBe(0);

    const root = receiver.spans.find((span) => span.name === "sandbox.run");
    const pi = receiver.spans.find((span) => span.name === "pi.run");

    if (!root || !pi) throw new Error("Missing the sandbox or Pi run span.");

    expect(pi.parentSpanId).toBe(root.spanId);

    for (const name of [
      "beachside.sandbox.create",
      "beachside.file.write",
      "beachside.exec",
      "beachside.file.read",
    ]) {
      const span = receiver.spans.find((candidate) => candidate.name === name);

      expect(span).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId });
    }

    const destroy = receiver.spans.find(
      (span) =>
        span.name === "beachside.operation.wait" &&
        span.attributes.some(
          ({ key, value }) => key === "beachside.operation.type" && value.stringValue === "destroy",
        ),
    );

    expect(destroy).toMatchObject({ traceId: root.traceId, parentSpanId: root.spanId });

    for (const span of receiver.spans) {
      expect(span.traceId).toBe(root.traceId);

      if (span.name.startsWith("pi.") || span === root) {
        expect(
          span.attributes.find(({ key }) => key === "demo.sandbox.id")?.value.stringValue,
        ).toBe("CANARY_NATIVE_ID");
      }
    }
  } finally {
    await receiver.stop();
  }
});

test("OpenRouter preserves the broker base path and accepts a model fallback", () => {
  const config = gatewayConfig("openrouter", {
    OPENROUTER_BASE_URL: "https://fixture.example/gateway/openrouter",
    OPENROUTER_API_KEY: "fixture-openrouter",
    PI_TRACING_MODEL: "openai/gpt-4.1-mini",
  });

  expect(config.baseUrl).toBe("https://fixture.example/gateway/openrouter");
  expect(config.hostname).toBe("fixture.example");
  expect(config.modelId).toBe("openai/gpt-4.1-mini");
  expect(() => selectedGateway(["--openrouter", "--kilo"])).toThrow();
  expect(() =>
    gatewayConfig("openrouter", {
      OPENROUTER_BASE_URL: "http://fixture.example/api",
      OPENROUTER_API_KEY: "fixture-openrouter",
      DEFAULT_MODEL: "openai/gpt-4.1-mini",
    }),
  ).toThrow("Set OPENROUTER_BASE_URL to an HTTPS");
});

test("Pi registers the OpenRouter broker and serializes Luna with reasoning effort none", async () => {
  const env = {
    OPENROUTER_BASE_URL: "https://fixture.example/gateway/openrouter",
    OPENROUTER_API_KEY: "fixture-openrouter",
    DEFAULT_MODEL: "openai/gpt-6-luna",
  };

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });

  const model = registerGatewayModel(runtime, "openrouter", env);

  expect(model).toMatchObject({
    id: "openai/gpt-6-luna",
    provider: "openrouter",
    api: "openai-completions",
    baseUrl: env.OPENROUTER_BASE_URL,
  });
  expect((await runtime.getAuth(model, { env }))?.auth.apiKey).toBe("fixture-openrouter");

  const result = await runtime.completeSimple(
    model,
    { messages: [{ role: "user", content: "fixture", timestamp: 0 }] },
    {
      env,
      onPayload(payload) {
        expect(payload).toMatchObject({
          model: "openai/gpt-6-luna",
          reasoning: { effort: "none" },
        });

        throw new Error("Fixture intercepted serialized request before transport.");
      },
    },
  );

  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Fixture intercepted serialized request before transport.");
});
