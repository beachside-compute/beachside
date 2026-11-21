import { SpanStatusCode } from "@opentelemetry/api";
import type { Context, Span } from "@opentelemetry/api";
import { ExportResultCode, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

export const traceContext = new W3CTraceContextPropagator();

export const answer = "4\n";

export const answerName = "answer.txt";

export class OtlpExportError extends Error {
  constructor(service: string) {
    super(`OTLP export failed for ${service}. Check the endpoint and authentication.`);
  }
}

export function tracing(
  service: string,
  runId: string,
  offline: boolean,
  url?: string,
  sandboxId?: string,
) {
  const protocol = url
    ? "http/json"
    : (process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ??
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL ??
      "http/protobuf");

  if (protocol !== "http/json" && protocol !== "http/protobuf") {
    throw new Error("Use http/protobuf or http/json for the OTLP traces protocol.");
  }

  const Exporter = protocol === "http/json" ? JsonTraceExporter : ProtobufTraceExporter;

  const exporter = new Exporter({ timeoutMillis: 5_000, url });
  let exportFailed = false;

  const trackedExporter: SpanExporter = {
    export(spans, callback) {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) exportFailed = true;

        callback({ code: result.code });
      });
    },
    shutdown: () => exporter.shutdown(),
  };

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": service }),
    spanProcessors: [
      new BatchSpanProcessor(trackedExporter, {
        scheduledDelayMillis: 30_000,
        exportTimeoutMillis: 6_000,
      }),
    ],
  });

  const tracer = provider.getTracer("beachside.pi-tracing");

  return {
    provider,
    start(name: string, parent: Context) {
      const span = tracer.startSpan(
        name,
        {
          attributes: {
            "demo.run.id": runId,
            "demo.mode": offline ? "scripted" : "live",
          },
        },
        parent,
      );

      if (sandboxId) span.setAttribute("demo.sandbox.id", sandboxId);

      return span;
    },
    async shutdown() {
      try {
        await provider.shutdown();
      } catch {
        throw new OtlpExportError(service);
      }

      if (exportFailed) throw new OtlpExportError(service);
    },
  };
}

export function endSpan(span: Span, error = false) {
  span.setStatus({ code: error ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
