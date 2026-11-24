import { SpanStatusCode } from "@opentelemetry/api";
import type { Attributes, Context, Span } from "@opentelemetry/api";
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
  constructor(service: string, cause: unknown) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
    const status = Number.isInteger(code) ? Number(code) : 0;

    const detail = status >= 300 && status <= 599 ? ` Receiver returned HTTP ${status}.` : "";

    super(`OTLP export failed for ${service}.${detail} Check the endpoint and authentication.`, {
      cause,
    });
  }
}

export function tracing(
  service: string,
  runId: string,
  offline: boolean,
  {
    url,
    sandboxId,
    sandboxProvider,
  }: { url?: string; sandboxId?: string; sandboxProvider?: string } = {},
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
  let exportFailure: OtlpExportError | undefined;

  const trackedExporter: SpanExporter = {
    export(spans, callback) {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          exportFailure = new OtlpExportError(service, result.error);
        }

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
      const attributes: Attributes = {
        "demo.run.id": runId,
        "demo.mode": offline ? "scripted" : "live",
      };

      if (sandboxId) attributes["demo.sandbox.id"] = sandboxId;

      if (sandboxProvider) attributes["beachside.provider"] = sandboxProvider;

      return tracer.startSpan(name, { attributes }, parent);
    },
    async shutdown() {
      try {
        await provider.shutdown();
      } catch (error) {
        throw exportFailure ?? new OtlpExportError(service, error);
      }

      if (exportFailure) throw exportFailure;
    },
  };
}

export function endSpan(span: Span, error = false) {
  span.setStatus({ code: error ? SpanStatusCode.ERROR : SpanStatusCode.OK });
  span.end();
}
