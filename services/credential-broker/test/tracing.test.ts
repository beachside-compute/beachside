import { expect, test } from "bun:test";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import { z } from "zod";
import type { TraceExportBindings } from "../src/observability/otlp";
import { startSpan } from "../src/observability/tracing";

const endpoint = "https://collector.test/v1/traces";

const collectorAuthorization = "Bearer collector-secret-canary";

const apiKey = "orchestrator-secret-canary-123456789";

const upstreamKey = "upstream-secret-canary";

const gatewayBody = '{"input":"prompt-canary"}';

const traceId = "1".repeat(32);

const parentSpanId = "2".repeat(16);

const traceparent = `00-${traceId}-${parentSpanId}-01`;

const sdkScope = "beachside.credential-broker";

const result = await build({
  entryPoints: [`${import.meta.dir}/../src/index.ts`],
  bundle: true,
  write: false,
  format: "esm",
  external: ["cloudflare:*"],
  loader: { ".sql": "text" },
});

const spanSchema = z.object({
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  spanId: z.string().regex(/^[a-f0-9]{16}$/),
  parentSpanId: z.string().optional(),
  name: z.string(),
  kind: z.literal(2),
  startTimeUnixNano: z.coerce.bigint(),
  endTimeUnixNano: z.coerce.bigint(),
  attributes: z.tuple([
    z.object({
      key: z.literal("http.response.status_code"),
      value: z.object({ intValue: z.coerce.number() }),
    }),
  ]),
  links: z.array(z.object({ traceId: z.string(), spanId: z.string() })),
  events: z.tuple([]),
  status: z.strictObject({ code: z.number() }),
});

const otlp = z.object({
  resourceSpans: z.tuple([
    z.object({
      resource: z.object({
        attributes: z.tuple([
          z.object({
            key: z.literal("service.name"),
            value: z.object({ stringValue: z.literal(sdkScope) }),
          }),
        ]),
      }),
      scopeSpans: z.tuple([
        z.object({
          scope: z.object({ name: z.literal(sdkScope) }),
          spans: z.tuple([spanSchema]),
        }),
      ]),
    }),
  ]),
});

function fixture(bindings: TraceExportBindings, collectorStatus = 200) {
  const exported: { authorization: string | null; contentType: string | null; body: string }[] = [];
  let upstreamCalls = 0;

  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: "broker",
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-09-25",
      durableObjects: { REGISTRY: { className: "GrantRegistry", useSQLite: true } },
      bindings: {
        BROKER_API_KEY: apiKey,
        BROKER_CONFIG: JSON.stringify({
          integrations: [
            {
              kind: "openai",
              id: "trace-canary",
              credential: { source: "worker-secret", binding: "CREDENTIAL_OPENAI" },
            },
          ],
        }),
        CREDENTIAL_OPENAI: upstreamKey,
        ...bindings,
      },
      async outboundService(request) {
        if (request.url === endpoint) {
          expect(request.method).toBe("POST");
          exported.push({
            authorization: request.headers.get("authorization"),
            contentType: request.headers.get("content-type"),
            body: await request.text(),
          });

          return new RuntimeResponse("collector-response-canary", { status: collectorStatus });
        }

        expect(request.url).toBe("https://api.openai.com/v1/responses?query=query-canary");
        expect(request.headers.get("authorization")).toBe(`Bearer ${upstreamKey}`);
        expect(request.headers.get("traceparent")).toBeNull();
        expect(await request.text()).toBe(gatewayBody);
        upstreamCalls++;

        return RuntimeResponse.json({ fixture: "response-canary" });
      },
    }),
  );

  return {
    exported,
    runtime,
    upstreamCalls: () => upstreamCalls,
    async issue(parent = traceparent) {
      const response = await runtime.dispatchFetch("http://broker.test/v1/grants", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          traceparent: parent,
        },
        body: JSON.stringify({ integrations: ["trace-canary"], ttlSeconds: 60 }),
      });

      expect(response.status).toBe(201);

      return z.object({ id: z.string(), token: z.string() }).parse(await response.json());
    },
    async gateway(token: string) {
      const response = await runtime.dispatchFetch(
        "http://broker.test/gateway/trace-canary/v1/responses?query=query-canary",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            traceparent: `00-${"f".repeat(32)}-${"f".repeat(16)}-01`,
            baggage: "trace-canary=baggage-canary",
          },
          body: gatewayBody,
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ fixture: "response-canary" });
    },
    async spans(count: number) {
      for (let attempt = 0; exported.length < count && attempt < 100; attempt++)
        await Bun.sleep(10);
      expect(exported).toHaveLength(count);

      return exported.map(
        ({ body }) => otlp.parse(JSON.parse(body)).resourceSpans[0].scopeSpans[0].spans[0],
      );
    },
  };
}

test("exports safe sampled grant and gateway spans with the verified parent and persisted link", async () => {
  const broker = fixture({
    BROKER_OTLP_TRACES_ENDPOINT: endpoint,
    BROKER_OTLP_AUTHORIZATION: collectorAuthorization,
  });

  try {
    const grant = await broker.issue();
    await broker.gateway(grant.token);
    await broker.issue(traceparent.replace(/01$/, "00"));
    const spans = await broker.spans(2);
    const issuance = spans.find(({ name }) => name === "beachside.broker.grant.create")!;
    const gateway = spans.find(({ name }) => name === "beachside.broker.gateway")!;
    expect(issuance).toMatchObject({ traceId, parentSpanId, links: [] });
    expect(issuance.attributes[0].value.intValue).toBe(201);
    expect(gateway.parentSpanId).toBeUndefined();
    expect(gateway.traceId).not.toBe(traceId);
    expect(gateway.traceId).not.toBe("f".repeat(32));
    expect(gateway.links).toEqual([{ traceId, spanId: issuance.spanId }]);
    expect(gateway.attributes[0].value.intValue).toBe(200);

    for (const span of spans)
      expect(span.endTimeUnixNano).toBeGreaterThanOrEqual(span.startTimeUnixNano);

    for (const request of broker.exported) {
      expect(request.authorization).toBe(collectorAuthorization);
      expect(request.contentType).toBe("application/json");

      for (const canary of [
        apiKey,
        upstreamKey,
        collectorAuthorization,
        grant.token,
        grant.id,
        "trace-canary",
        "query-canary",
        "prompt-canary",
        "baggage-canary",
        "response-canary",
        "/v1/responses",
      ]) {
        expect(request.body).not.toContain(canary);
      }
    }
  } finally {
    await broker.runtime.dispose();
  }
});

test("collector rejection leaves grant issuance and upstream forwarding successful", async () => {
  const broker = fixture({ BROKER_OTLP_TRACES_ENDPOINT: endpoint }, 503);

  try {
    const grant = await broker.issue();
    await broker.gateway(grant.token);
    await broker.spans(2);
    expect(broker.upstreamCalls()).toBe(1);
    expect(broker.exported.every(({ authorization }) => authorization === null)).toBe(true);
  } finally {
    await broker.runtime.dispose();
  }
});

test("disabled tracing makes no collector requests", async () => {
  const broker = fixture({});

  try {
    const grant = await broker.issue();
    await broker.gateway(grant.token);
    expect(broker.upstreamCalls()).toBe(1);
  } finally {
    await broker.runtime.dispose();
  }

  expect(broker.exported).toEqual([]);
});

test.each([
  { BROKER_OTLP_TRACES_ENDPOINT: "http://collector.test/v1/traces" },
  { BROKER_OTLP_TRACES_ENDPOINT: endpoint, BROKER_OTLP_AUTHORIZATION: "invalid\r\nauthorization" },
])("invalid runtime tracing settings skip instrumentation %#", (bindings) => {
  const span = startSpan(
    bindings,
    () => {
      throw new Error("Unexpected export");
    },
    "grant.create",
  );

  expect(span).toBeUndefined();
});
