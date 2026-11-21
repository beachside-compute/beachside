interface OtlpAttribute {
  key: string;
  value: { stringValue?: string };
}

interface OtlpSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  attributes: OtlpAttribute[];
  status: { code: number };
}

interface OtlpExport {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: { spans: OtlpSpan[] }[];
  }[];
}

export function collectTraces() {
  const spans: (OtlpSpan & { service: string })[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/traces") {
        return new Response(null, { status: 404 });
      }

      // This loopback receiver only accepts the example's known OTLP/HTTP JSON exporter.
      const body: OtlpExport = await request.json();

      for (const { resource, scopeSpans } of body.resourceSpans) {
        const service =
          resource.attributes.find(({ key }) => key === "service.name")?.value.stringValue ?? "";

        for (const scope of scopeSpans) {
          for (const span of scope.spans) spans.push({ ...span, service });
        }
      }

      return Response.json({});
    },
  });

  return {
    spans,
    endpoint: new URL("/v1/traces", server.url).href,
    async stop() {
      await server.stop(true);
    },
  };
}

export function printTrace(spans: ReturnType<typeof collectTraces>["spans"], rootId: string) {
  function print(spanId: string, indent: string) {
    const span = spans.find((candidate) => candidate.spanId === spanId);

    if (!span) return;
    console.log(
      `${indent}${span.name} (${span.service})${span.status.code === 2 ? " [error]" : ""}`,
    );

    for (const child of spans) {
      if (child.parentSpanId === spanId) print(child.spanId, `${indent}  `);
    }
  }

  print(rootId, "");
}
