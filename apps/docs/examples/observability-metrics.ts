import { metrics } from "@opentelemetry/api";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Beachside, Image } from "beachside";
import { daytona } from "@beachside/daytona";

// Metrics only: no tracer provider is registered, so Beachside records no spans.
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
      exportIntervalMillis: 10_000,
    }),
  ],
});

metrics.setGlobalMeterProvider(meterProvider);

try {
  const client = await Beachside.connect(
    daytona({
      apiKey: process.env.DAYTONA_API_KEY!,
      target: process.env.DAYTONA_TARGET ?? "us",
      ttlMinutes: 15,
      network: "daytona-default",
    }),
  );

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("daytona-small") });

    await box.destroy();
  } finally {
    await client.close();
  }
} finally {
  // Shutdown exports the final collection before the process exits.
  await meterProvider.shutdown();
}
