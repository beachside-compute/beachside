import { expect, test } from "bun:test";
import { metrics, type Meter, type MeterProvider as ApiMeterProvider } from "@opentelemetry/api";
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
import { Telemetry } from "./observability";
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
  const reference = error.reference;

  const observed = await client.operations.observe({
    scope: client.scope,
    kind: "create",
    operationId: reference.operationId,
    submissionId: reference.submissionId,
    token: reference.token,
    tokenVersion: reference.tokenVersion,
  });

  expect(observed.kind).toBe("pending");
  await client.close();

  const found = await collect(reader);

  const create = found
    .get("beachside.operation.duration")!
    .points.find((p) => p.attributes["beachside.operation.name"] === "beachside.sandbox.create")!;

  expect(create.attributes["beachside.call.outcome"]).toBe("error");
  expect(create.attributes["beachside.error.code"]).toBe("OUTCOME_UNKNOWN");

  const phases = found
    .get("beachside.phase.duration")!
    .points.map((p) => p.attributes["beachside.phase"]);

  expect(phases).toContain("observe");
  await meterProvider.shutdown();
});

test("errors outside the SDK vocabulary still carry the bounded INTERNAL code", async () => {
  const { reader, meterProvider } = meters();
  const telemetry = new Telemetry({ tracing: false, metrics: { meterProvider } }, "direct", "boxd");

  await expect(
    telemetry.run("beachside.exec", async () => {
      throw new Error("CANARY raw adapter failure");
    }),
  ).rejects.toThrow();

  const point = (await collect(reader)).get("beachside.operation.duration")!.points[0]!;

  expect(point.attributes).toMatchObject({
    "beachside.provider": "boxd",
    "beachside.call.outcome": "error",
    "beachside.error.code": "INTERNAL",
  });
  await meterProvider.shutdown();
});

test("metrics: false suppresses a registered global provider while tracing stays on", async () => {
  const exporter = new InMemorySpanExporter();

  const tracerProvider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  const global = meters();
  metrics.setGlobalMeterProvider(global.meterProvider);

  try {
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
    expect((await global.reader.collect()).resourceMetrics.scopeMetrics).toHaveLength(0);
  } finally {
    metrics.disable();
    await tracerProvider.shutdown();
    await global.meterProvider.shutdown();
  }
});

test("omitted metrics use a global provider registered after connect", async () => {
  const client = await Beachside.connect({
    ...fixtureAdapter(),
    config: {},
    credentials: {},
    tracing: false,
  });

  const global = meters();
  metrics.setGlobalMeterProvider(global.meterProvider);

  try {
    await client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });
    await client.close();

    const names = (await collect(global.reader))
      .get("beachside.operation.duration")!
      .points.map((p) => p.attributes["beachside.operation.name"]);

    expect(names).toContain("beachside.sandbox.create");
  } finally {
    metrics.disable();
    await global.meterProvider.shutdown();
  }
});

test("concurrent calls are counted in flight and settle back to zero", async () => {
  const { reader, meterProvider } = meters();
  let release!: () => void;
  const delay = new Promise<void>((resolve) => (release = resolve));
  const fixture = fixtureAdapter({ delay });

  const client = await Beachside.connect({
    ...fixture,
    config: {},
    credentials: {},
    tracing: false,
    metrics: { meterProvider },
  });

  const creates = [1, 2].map(() =>
    client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") }),
  );

  while (fixture.counts.create < 2) await Bun.sleep(1);

  const active = async () =>
    (await collect(reader))
      .get("beachside.operation.active")!
      .points.find((p) => p.attributes["beachside.operation.name"] === "beachside.sandbox.create")
      ?.value;

  expect(await active()).toBe(2);
  release();
  await Promise.all(creates);
  expect(await active()).toBe(0);
  await client.close();
  await meterProvider.shutdown();
});

test("a throwing meter cannot fail calls or leave the in-flight gauge raised", async () => {
  const { reader, meterProvider } = meters();

  // A provider whose histograms throw on record while its counters still work.
  const broken: ApiMeterProvider = {
    getMeter(name, version, options): Meter {
      const meter = meterProvider.getMeter(name, version, options);

      return Object.assign(Object.create(meter), {
        createHistogram: () => ({
          record() {
            throw new Error("broken histogram");
          },
        }),
        createUpDownCounter: meter.createUpDownCounter.bind(meter),
        createCounter: meter.createCounter.bind(meter),
      });
    },
  };

  const client = await Beachside.connect({
    ...fixtureAdapter(),
    config: {},
    credentials: {},
    tracing: false,
    metrics: { meterProvider: broken },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("CANARY_IMAGE") });
  await box.writeTextFile("/CANARY_FILE", "CANARY_TEXT");
  await client.close();

  const found = await collect(reader);
  expect(found.get("beachside.operation.active")!.points.every((p) => p.value === 0)).toBe(true);
  expect(found.get("beachside.file.bytes")!.points[0]!.value).toBe(11);
  await meterProvider.shutdown();
});

function streamAdapter(options: { name?: string; failAfter?: number; failWrite?: boolean } = {}) {
  return defineAdapter({
    name: options.name ?? "streams",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "fixture", id: "one" }, partition: {} },
        supports: { images: ["prepared" as const], network: ["blocked" as const] },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        files: {
          maxBytes: 16,
          // Larger than maxBytes, so a buffered readFile falls back to the stream.
          read: async () => new Uint8Array(30),
          write: async (input: { bytes: Uint8Array }) => {
            if (options.failWrite) throw new AdapterError("UNAVAILABLE", "write lost");

            return { bytesWritten: input.bytes.length };
          },
          readStream: async () => {
            let sent = 0;

            return new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (sent === options.failAfter)
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

            if (options.failWrite) throw new AdapterError("UNAVAILABLE", "write lost");

            return { bytesWritten: count };
          },
        },
      };
    },
  });
}

async function fileMetrics(
  options: Parameters<typeof streamAdapter>[0],
  work: (box: Awaited<ReturnType<typeof boxFor>>) => Promise<void>,
) {
  const { reader, meterProvider } = meters();
  const { client, box } = await boxFor(options, meterProvider);

  try {
    await work(box);
  } finally {
    await client.close();
  }

  const found = await collect(reader);
  await meterProvider.shutdown();

  const bytes = Object.fromEntries(
    (found.get("beachside.file.bytes")?.points ?? []).map((p) => [
      `${p.attributes["beachside.operation.name"]}`,
      p.value,
    ]),
  );

  const calls = found
    .get("beachside.operation.duration")!
    .points.map((p) => `${p.attributes["beachside.operation.name"]}`)
    .filter((name) => name.startsWith("beachside.file."));

  return { bytes, calls, found };
}

async function boxFor(options: Parameters<typeof streamAdapter>[0], meterProvider: MeterProvider) {
  const client = await Beachside.connect({
    adapter: streamAdapter(options),
    config: {},
    credentials: {},
    tracing: false,
    metrics: { meterProvider },
  });

  return { client, box: await client.sandboxes.create({ environment: Image.prepared("base") }) };
}

async function* input() {
  yield new Uint8Array(7);
  yield new Uint8Array(5);
}

test("stream reads and writes record bytes; failed and abandoned reads keep delivered chunks", async () => {
  const full = await fileMetrics({}, async (box) => {
    await box.writeFileStream("/out", input());

    for await (const _chunk of box.readFileStream("/in"));
  });

  expect(full.bytes).toEqual({
    "beachside.file.write_stream": 12,
    "beachside.file.read_stream": 30,
  });

  const failed = await fileMetrics({ failAfter: 2 }, async (box) => {
    await expect(
      (async () => {
        for await (const _chunk of box.readFileStream("/in"));
      })(),
    ).rejects.toThrow();
  });

  expect(failed.bytes).toEqual({ "beachside.file.read_stream": 20 });

  const abandoned = await fileMetrics({}, async (box) => {
    for await (const _chunk of box.readFileStream("/in")) break;
  });

  expect(abandoned.bytes).toEqual({ "beachside.file.read_stream": 10 });
});

test("failed writes record no bytes, since the provider never confirmed them", async () => {
  const failed = await fileMetrics({ failWrite: true }, async (box) => {
    await expect(box.writeFile("/out", new Uint8Array(4))).rejects.toThrow();
    await expect(box.writeFileStream("/out", input())).rejects.toThrow();
  });

  expect(failed.bytes).toEqual({});
  expect(failed.calls.toSorted()).toEqual(["beachside.file.write", "beachside.file.write_stream"]);
});

test("a large readFile is one call with one byte count, and first-party labels reach metrics", async () => {
  const large = await fileMetrics({ name: "boxd" }, async (box) => {
    expect((await box.readFile("/big")).byteLength).toBe(30);
  });

  expect(large.calls).toEqual(["beachside.file.read"]);
  expect(large.bytes).toEqual({ "beachside.file.read": 30 });

  const providers = large.found
    .get("beachside.operation.duration")!
    .points.map((p) => p.attributes["beachside.provider"]);

  expect(new Set(providers)).toEqual(new Set(["boxd"]));
});
