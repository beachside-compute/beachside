import { expect, test } from "bun:test";
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AdapterError, defineAdapter } from "@beachside/adapter";
import { z } from "zod";
import { Beachside, Image, OutcomeUnknownError } from "./index";
import { fixtureAdapter } from "../../sdk-qualification/observability/adapter";

class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

async function collect(reader: TestReader) {
  const { resourceMetrics } = await reader.collect();
  const found = new Map<string, { unit: string; points: DataPoint<number | Histogram>[] }>();

  for (const scope of resourceMetrics.scopeMetrics) {
    expect(scope.scope.name).toBe("beachside");

    for (const metric of scope.metrics)
      // SAFETY: The SDK reports number points for counters and Histogram points for histograms.
      found.set(metric.descriptor.name, {
        unit: metric.descriptor.unit,
        points: metric.dataPoints as DataPoint<number | Histogram>[],
      });
  }

  expect(JSON.stringify([...found])).not.toContain("CANARY");

  return found;
}

function meters() {
  const reader = new TestReader();

  return { reader, meterProvider: new MeterProvider({ readers: [reader] }) };
}

test("metrics record durations, outcomes, phases and bytes with tracing disabled", async () => {
  const { reader, meterProvider } = meters();
  const fixture = fixtureAdapter();

  const client = await Beachside.connect({
    ...fixture,
    config: {},
    credentials: {},
    tracing: false,
    metrics: { meterProvider },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });
    await box.writeTextFile("/CANARY_FILE", "CANARY_TEXT");
    await box.readTextFile("/CANARY_FILE");
  } finally {
    await client.close();
  }

  const found = await collect(reader);
  const duration = found.get("beachside.operation.duration")!;
  expect(duration.unit).toBe("s");

  const create = duration.points.find(
    (p) => p.attributes["beachside.operation.name"] === "beachside.sandbox.create",
  )!;

  expect(create.attributes).toEqual({
    "beachside.operation.name": "beachside.sandbox.create",
    "beachside.operation.type": "create",
    "beachside.provider": "custom",
    "beachside.mode": "direct",
    "beachside.call.outcome": "success",
  });
  // SAFETY: Histogram instruments produce Histogram data points.
  expect((create.value as Histogram).count).toBe(1);

  const phases = found
    .get("beachside.phase.duration")!
    .points.map((p) => p.attributes["beachside.phase"]);

  expect(phases).toEqual(expect.arrayContaining(["prepare", "submit", "wait"]));

  const active = found.get("beachside.operation.active")!;
  expect(active.points.every((p) => p.value === 0)).toBe(true);

  const bytes = found.get("beachside.file.bytes")!;
  expect(bytes.unit).toBe("By");

  const moved = Object.fromEntries(
    bytes.points.map((p) => [p.attributes["beachside.operation.name"], p.value]),
  );

  expect(moved).toEqual({ "beachside.file.write": 11, "beachside.file.read": 19 });
  await meterProvider.shutdown();
});

test("failed calls carry the bounded error code and metrics can be off while tracing is on", async () => {
  const { reader, meterProvider } = meters();
  const fixture = fixtureAdapter({ lost: true });

  const client = await Beachside.connect({
    adapter: fixture.adapter,
    config: {},
    credentials: {},
    tracing: false,
    metrics: { meterProvider },
  });

  const error = await client.sandboxes
    .create({ environment: Image.prepared("CANARY_IMAGE") })
    .catch((e) => e);

  expect(error).toBeInstanceOf(OutcomeUnknownError);
  await client.close();

  const create = (await collect(reader))
    .get("beachside.operation.duration")!
    .points.find((p) => p.attributes["beachside.operation.name"] === "beachside.sandbox.create")!;

  expect(create.attributes["beachside.call.outcome"]).toBe("error");
  expect(create.attributes["beachside.error.code"]).toBe("OUTCOME_UNKNOWN");
  await meterProvider.shutdown();

  const exporter = new InMemorySpanExporter();

  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const off = meters();

  const traced = await Beachside.connect({
    ...fixtureAdapter(),
    config: {},
    credentials: {},
    tracing: { tracerProvider },
    metrics: false,
  });

  await traced.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });
  await traced.close();

  const spans = exporter.getFinishedSpans();
  expect(spans.some((s) => s.name === "beachside.sandbox.create")).toBe(true);
  expect(spans.find((s) => s.name === "beachside.prepare")?.attributes["beachside.phase"]).toBe(
    "prepare",
  );
  expect((await off.reader.collect()).resourceMetrics.scopeMetrics).toHaveLength(0);
  await tracerProvider.shutdown();
  await off.meterProvider.shutdown();
});

function streamAdapter(failAfter?: number) {
  return defineAdapter({
    name: "streams",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
        supports: { images: ["prepared" as const], network: ["blocked" as const] },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        files: {
          maxBytes: 1024,
          readStream: async () => {
            let sent = 0;

            return new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (sent === failAfter)
                    controller.error(new AdapterError("UNAVAILABLE", "stream lost"));
                  else if (sent === 3) controller.close();
                  else {
                    sent++;
                    controller.enqueue(new Uint8Array(10));
                  }
                },
              },
              { highWaterMark: 0 },
            );
          },
          writeStream: async ({ bytes }: { bytes: AsyncIterable<Uint8Array> }) => {
            let count = 0;

            for await (const chunk of bytes) count += chunk.length;

            return { bytesWritten: count };
          },
        },
      };
    },
  });
}

async function streamBytes(failAfter?: number) {
  const { reader, meterProvider } = meters();

  const client = await Beachside.connect({
    adapter: streamAdapter(failAfter),
    config: {},
    credentials: {},
    tracing: false,
    metrics: { meterProvider },
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("base") });

    async function* input() {
      yield new Uint8Array(7);
      yield new Uint8Array(5);
    }

    await box.writeFileStream("/out", input());

    try {
      for await (const _chunk of box.readFileStream("/in"));
    } catch {
      // A failed stream still records the bytes it delivered.
    }
  } finally {
    await client.close();
  }

  const points = (await collect(reader)).get("beachside.file.bytes")!.points;
  await meterProvider.shutdown();

  return Object.fromEntries(
    points.map((p) => [`${p.attributes["beachside.operation.name"]}`, p.value]),
  );
}

test("stream reads and writes record bytes, including chunks delivered before a failure", async () => {
  expect(await streamBytes()).toEqual({
    "beachside.file.write_stream": 12,
    "beachside.file.read_stream": 30,
  });

  expect((await streamBytes(2))["beachside.file.read_stream"]).toBe(20);
});
