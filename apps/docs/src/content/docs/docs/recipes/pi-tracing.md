---
title: Trace a Pi run
description: Run the Pi agent locally or in a boxd sandbox and export one OpenTelemetry trace covering the host, the Beachside SDK and Pi's model and tool calls.
---

This recipe runs the [Pi](https://github.com/earendil-works/pi) coding agent in a separate process, asks it to write `4` to `answer.txt` and read it back, then checks the file independently. The host and Pi share one OpenTelemetry trace: the parent passes W3C trace context to Pi, and Pi's model and tool calls appear as children of the host's run span. In the sandbox variant, the Beachside SDK's create, exec and file spans join the same trace.

**Source:** [`examples/pi-tracing`](https://github.com/beachside-compute/beachside/tree/main/examples/pi-tracing).

```text
demo.run (beachside-pi-demo)
  pi.run (beachside-pi-agent)
    pi.model (beachside-pi-agent)
    pi.tool.write (beachside-pi-agent)
    pi.model (beachside-pi-agent)
    pi.tool.read (beachside-pi-agent)
    pi.model (beachside-pi-agent)
  demo.verify (beachside-pi-demo)
```

Spans carry provider, model, token counts and status. They never carry prompts, model output, tool arguments, file contents or credentials.

## What you need

- A checkout of the repository with dependencies installed (see [Recipes](/docs/recipes/)).
- Nothing else for the offline run.
- For a live run, a model gateway key: OpenRouter, Kilo AI Gateway, or any model Pi already has credentials for.
- For the sandbox run, a [boxd](/docs/providers/boxd/) API key and organization, plus an HTTPS OTLP endpoint the sandbox can reach.

## Run it offline

```sh
bun run --cwd examples pi:trace --offline
```

Pi's scripted provider supplies deterministic responses to the real agent loop, so this needs no model credentials, viewer or sandbox. The example starts a loopback OTLP receiver, checks that it received the span tree above, and prints it with the run ID and trace ID.

## Use a live model

Pick a configured Pi model. Model calls may incur charges.

```sh
PI_TRACING_MODEL=provider/model-id bun run --cwd examples pi:trace
```

For OpenRouter, put `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` and `DEFAULT_MODEL` in an env file and pass `--openrouter`. Use a full OpenRouter model ID with tool support. For Kilo AI Gateway, put `KILO_API_KEY` and `DEFAULT_MODEL` in an env file and pass `--kilo`.

```sh
bun --env-file="$HOME/.config/openrouter.env" examples/pi-tracing/main.ts --openrouter
```

To keep model keys out of the run, point the base URL at a [credential broker](/docs/credential-broker/model-gateways/) gateway, such as `https://broker.example/gateway/openrouter`.

## Run Pi in a boxd sandbox

Put `BOXD_API_KEY` in an env file and set `BOXD_ORG` to the key's organization. `BOXD_REGION` is optional. The sandbox can't reach a receiver on your machine, so set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to an HTTPS URL, such as Grafana Cloud or a tunnel to a local viewer (see below).

```sh
BOXD_ORG=your-org bun --env-file="$HOME/.config/boxd.env" \
  --env-file="$HOME/.config/openrouter.env" --env-file="$HOME/.config/grafana.env" \
  examples/pi-tracing/boxd.ts --openrouter
```

Pass `--kilo` to use Kilo instead; it is also the default when no gateway flag is given. The host creates a boxd microVM with a ten-minute expiry, uploads the Pi entrypoint and a pinned dependency manifest, installs them, and runs Pi. Only the Pi command receives the gateway key, model, OTLP configuration and trace context; the boxd key stays on the host. The host reads `answer.txt` through Beachside, then destroys the sandbox and prints the trace and sandbox IDs.

## View the trace

**In a terminal.** Run [otel-tui](https://github.com/ymtdzzz/otel-tui) and point the example at it:

```sh
otel-tui --host 127.0.0.1
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
  bun run --cwd examples pi:trace --offline
```

**On your desktop.** Run [OpenTelemetry Desktop Viewer](https://github.com/CtrlSpice/otel-desktop-viewer) with `otel-desktop-viewer --host 127.0.0.1`. For the boxd run, expose its OTLP port with a temporary tunnel such as `cloudflared tunnel --url http://127.0.0.1:4318`, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to the tunnel's URL plus `/v1/traces`, and stop the tunnel when the run finishes.

**In Grafana Cloud.** Set the stack's `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` from its OpenTelemetry configuration page. Export uses OTLP/HTTP protobuf by default; set `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json` for a receiver that expects JSON.

Find the trace by the trace ID the run prints. For tracing Beachside in your own application, see [Tracing, metrics and safe diagnostics](/docs/observability/).

## Test

```sh
bun test examples/pi-tracing/pi-tracing.test.ts
```

The tests check exported OTLP batches, parent links and statuses, use loopback sockets only, and make no live model calls.
