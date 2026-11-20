# Trace a local Pi run

From the repository root with Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run --cwd examples pi:trace --offline
```

The parent launches a separate Bun process embedding the pinned [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md). Pi's scripted provider supplies deterministic responses to the real Pi agent loop. Pi uses its file tools to write `4` followed by a newline to `answer.txt`, then reads it. The parent verifies the exact contents independently. Each run creates and removes its own temporary directory.

The example starts a loopback OTLP/HTTP receiver, checks that it received the expected span tree, and prints that tree alongside the run ID and trace ID. The offline command requires no model credentials, external viewer, or sandbox provider.

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

## Live model

Choose a configured Pi model and use the provider's environment credentials or existing Pi credentials. Model calls may incur charges.

```sh
PI_TRACING_MODEL=provider/model-id bun run --cwd examples pi:trace
```

For a live run through Kilo Gateway, put `KILO_API_KEY` and `DEFAULT_MODEL` in your external env file and use `--kilo`. Pi registers the configured model ID in memory and uses Kilo's OpenAI-compatible chat completions endpoint. [Kilo Gateway API reference](https://kilo.ai/docs/gateway/api-reference)

```sh
bun --env-file="$HOME/.config/kilo.env" --env-file="$HOME/.config/grafana.env" \
  examples/pi-tracing/main.ts --kilo
```

Load the Grafana env file to send traces to your stack. Omit it to use the built-in receiver when your shell has no OTLP endpoint configured.

The child uses only Pi's `read` and `write` tools, each restricted to the temporary `answer.txt` path. Pi loads model and credential configuration in live mode. It keeps the session in memory, skips local extension and context-file discovery, and disables Pi's install/update telemetry. The parent stops waiting and kills an unresponsive child after 90 seconds. A forced process kill can lose pending child spans.

The parent passes W3C `traceparent` and optional `tracestate` to the child through environment variables. The child extracts the context as a remote parent. The app puts the same UUID in `demo.run.id` on every span and marks spans with `demo.mode` (`scripted` or `live`). A `pi.model` span measures Pi's turn preparation and assistant response through Pi's session events. The spans carry provider, model and token counts where Pi reports them. The bridge exports status codes and omits prompts, assistant text, tool arguments and output, file contents, exception messages and credentials. Both processes await their OpenTelemetry provider shutdown to drain pending spans.

## Run Pi in a Boxd sandbox

Provide `BOXD_API_KEY` in your Boxd env file and set `BOXD_ORG` to the key's organization. `BOXD_REGION` is optional. Build the workspace packages and load the Boxd, Kilo and Grafana configuration when launching the example.

```sh
bun run build:packages
BOXD_ORG=your-org bun --env-file="$HOME/.config/sandbar.env" \
  --env-file="$HOME/.config/kilo.env" --env-file="$HOME/.config/grafana.env" \
  examples/pi-tracing/boxd.ts
```

The parent creates a Boxd microVM from the pinned Bun Debian image using Beachside's scoped sandbox API. It uploads the Pi entrypoint, its telemetry helper and a manifest with exact direct dependency versions, then installs those dependencies. Only the Pi command receives the Kilo key, model, OTLP configuration, and W3C trace context. The Boxd key stays with the host. The sandbox can reach the npm registry, Kilo Gateway, and the configured HTTPS OTLP endpoint.

The active `sandbox.run` span parents the Beachside SDK lifecycle, exec and file spans as well as the guest's `pi.run`. The guest Pi spans and the host's run and verification spans include `demo.run.id` and `demo.sandbox.id`. The parent reads `answer.txt` through Beachside before scoped destruction. The sandbox has a ten-minute provider expiry and uses its temporary machine filesystem without persistent volumes. The example prints the trace ID and sandbox ID for inspection.

On November 20, 2026, a live Boxd run through Kilo verified that `answer.txt` contained exactly `4\n`. The local desktop viewer showed one trace with 42 spans, 36 from the host and six from Pi in the guest. A separate Boxd lookup confirmed the sandbox had been destroyed. In a separate run, Grafana Cloud accepted both OTLP export requests.

## View traces in a terminal

Install and run [otel-tui](https://github.com/ymtdzzz/otel-tui) in one terminal:

```sh
brew install ymtdzzz/tap/otel-tui
otel-tui --host 127.0.0.1
```

Send the demo trace to it from another terminal:

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces \
  bun run --cwd examples pi:trace --offline
```

With an external receiver, the command prints the run ID and trace ID. Use the trace ID to find the tree in the viewer.

## View Boxd traces on your desktop

Start [OpenTelemetry Desktop Viewer](https://github.com/CtrlSpice/otel-desktop-viewer). The browser UI opens on port 8000, and `--db` keeps traces between sessions.

```sh
otel-desktop-viewer --host 127.0.0.1 --db ./pi-traces.duckdb
```

Boxd needs an HTTPS endpoint it can reach. In a second terminal, expose only the OTLP/HTTP receiver using a temporary tunnel. The tunnel URL allows public submissions until you stop the tunnel. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

```sh
cloudflared tunnel --url http://127.0.0.1:4318
```

Replace the placeholder with the HTTPS URL from the tunnel. Load only the Boxd and Kilo env files. The invocation clears inherited Grafana headers and uses the full trace-specific endpoint.

```sh
BOXD_ORG=your-org \
OTEL_EXPORTER_OTLP_ENDPOINT= \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://your-tunnel.trycloudflare.com/v1/traces \
OTEL_EXPORTER_OTLP_HEADERS= OTEL_EXPORTER_OTLP_TRACES_HEADERS= \
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf \
  bun --env-file="$HOME/.config/sandbar.env" --env-file="$HOME/.config/kilo.env" \
  examples/pi-tracing/boxd.ts
```

Find the trace ID printed by the run in the viewer. Stop the tunnel when the run finishes.

## Forward to Grafana Cloud

In your Grafana Cloud stack, open the **OpenTelemetry** configuration. Set the stack-provided `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in the shell. The base endpoint typically ends in `/otlp`. The exporter appends `/v1/traces`. If you set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, use the full path ending in `/otlp/v1/traces`. [Grafana Cloud OTLP setup](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp/)

```sh
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf bun run --cwd examples pi:trace --offline
```

External export defaults to OTLP/HTTP protobuf, which Grafana Cloud accepts. Set `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json` for a receiver expecting JSON. The built-in loopback receiver always uses JSON. [Grafana Cloud OTLP formats](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)

## Test

```sh
bun test examples/pi-tracing/pi-tracing.test.ts
```

The tests receive real exported OTLP batches and check the trace IDs, child parent IDs, run UUID, service names, success and error statuses, and remote `tracestate`. They also check that exports reach the receiver before each process exits, including a child that fails during model setup. A rejected export gives a nonzero command exit without printing the receiver response. A deterministic adapter and real Pi subprocess prove that Beachside SDK operations and Pi share the same sandbox root trace. The tests use loopback sockets and skip live model calls.
