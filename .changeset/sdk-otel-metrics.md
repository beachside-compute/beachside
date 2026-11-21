---
"beachside": minor
---

Record OpenTelemetry metrics for SDK calls: `beachside.operation.duration`, `beachside.phase.duration`, `beachside.operation.active` and `beachside.file.bytes`. Metrics use the application's meter provider and are controlled separately from tracing with the new `metrics` connect option. Telemetry now reports every first-party adapter (boxd, Freestyle, Archil, Upstash Box and the rest) by its own provider label instead of `custom`, and phase spans report `beachside.phase` as `prepare`, `submit` or `wait`.
