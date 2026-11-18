import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { grantIdPattern, newGrantToken, tokenHash } from "./grants/tokens";
import { orchestrator } from "./auth";
import { integrationId, maxGrantTtlSeconds, parseConfig, permissionKey } from "./config";
import type { Integration } from "./config";
import { workerSecretSource } from "./credentials/sources/worker-secret";
import type { WorkerSecretBindings } from "./credentials/sources/worker-secret";
import { failure, upstream, withCompletion } from "./proxy/forward";
import { GrantRegistry } from "./grants/registry";
import { route, sandboxToken } from "./proxy/routes";
import type { TraceExportBindings } from "./observability/otlp";
import { finishSpan, grantOrigin, parseTraceparent, startSpan } from "./observability/tracing";

export { GrantRegistry };

interface Env extends TraceExportBindings, WorkerSecretBindings {
  BROKER_CONFIG: string;
  BROKER_API_KEY?: string;
  REGISTRY: DurableObjectNamespace<GrantRegistry>;
}

type Worker = { Bindings: Env };

type WorkerContext = Context<Worker>;

const registryName = "grant-registry";

const issueRequest = z.strictObject({
  integrations: z.array(integrationId).min(1).max(16),
  ttlSeconds: z.number().int().min(1).max(maxGrantTtlSeconds),
});

const app = new Hono<Worker>();

app.onError(() => failure(503, "broker_unavailable"));

app.post("/v1/grants", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG);
  const request = context.req.raw;
  const principal = await orchestrator(request, config, context.env.BROKER_API_KEY);

  if (!principal) return failure(401, "orchestrator_authentication_required");

  const parent = parseTraceparent(request.headers.get("traceparent"));

  const span = startSpan(
    context.env,
    (work) => context.executionCtx.waitUntil(work),
    "grant.create",
    parent,
  );

  let status = 503;

  try {
    const input = issueRequest.safeParse(await readGrantRequest(request));

    if (
      !input.success ||
      new Set(input.data.integrations).size !== input.data.integrations.length
    ) {
      status = 400;

      return failure(status, "invalid_grant_request");
    }

    const { integrations, ttlSeconds } = input.data;

    if (integrations.some((id) => !principal.integrations.includes(id))) {
      status = 403;

      return failure(status, "integration_forbidden");
    }

    const selected = config.integrations.filter(({ id }) => integrations.includes(id));

    if (!(await credentialsAvailable(context.env, selected))) {
      return failure(status, "credential_unavailable");
    }

    const token = newGrantToken();
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + ttlSeconds * 1_000;

    const ok = await registry(context).create({
      id,
      hash: await tokenHash(token),
      owner: principal.owner,
      permissions: selected.map(permissionKey),
      expiresAt,
      traceparent: grantOrigin(span, parent),
    });

    if (!ok) {
      status = 429;

      return failure(status, "grant_limit");
    }

    status = 201;

    return Response.json(
      { id, token, expiresAt: new Date(expiresAt).toISOString(), integrations },
      { status, headers: { "cache-control": "no-store" } },
    );
  } finally {
    finishSpan(span, status);
  }
});

app.delete("/v1/grants/:id", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG);
  const principal = await orchestrator(context.req.raw, config, context.env.BROKER_API_KEY);

  if (!principal) return failure(401, "orchestrator_authentication_required");

  const parent = parseTraceparent(context.req.header("traceparent") ?? null);

  const span = startSpan(
    context.env,
    (work) => context.executionCtx.waitUntil(work),
    "grant.revoke",
    parent,
  );

  let status = 503;

  try {
    const id = context.req.param("id");

    if (!grantIdPattern.test(id)) {
      status = 400;

      return failure(status, "invalid_grant_id");
    }

    await registry(context).revoke(id, principal.owner, principal.admin);
    status = 204;

    return new Response(null, { status, headers: { "cache-control": "no-store" } });
  } finally {
    finishSpan(span, status);
  }
});

app.all("*", async (context) => {
  const config = parseConfig(context.env.BROKER_CONFIG);
  const request = context.req.raw;
  const target = route(new URL(request.url), request.method, config);

  if (!target) return failure(404, "unsupported_route");

  const token = sandboxToken(request, target);

  if (!token) return failure(401, "grant_authentication_required", target.type === "git");

  const store = registry(context);

  const authorized = await store.authorize(
    await tokenHash(token),
    permissionKey(target.integration),
  );

  if (authorized.status === "invalid") return failure(401, "grant_invalid", target.type === "git");

  if (authorized.status === "forbidden") return failure(403, "integration_forbidden");

  if (authorized.status !== "allowed") return failure(429, "grant_request_limit");

  const origin = parseTraceparent(authorized.traceparent);

  const span = startSpan(
    context.env,
    (work) => context.executionCtx.waitUntil(work),
    "gateway",
    undefined,
    origin,
  );

  let completed = false;

  const complete = (status: number, failed?: boolean) => {
    if (completed) return;
    completed = true;
    finishSpan(span, status, failed);
    // A lost release can hold a slot until this grant expires. It never widens access.
    context.executionCtx.waitUntil(store.release(authorized.leaseId).catch(() => {}));
  };

  try {
    const credential = await workerSecretSource(context.env).resolve(target.integration.credential);

    if (!credential || (credential.expiresAt !== undefined && credential.expiresAt <= Date.now())) {
      complete(503);

      return failure(503, "credential_unavailable");
    }

    const response = await upstream(request, target, credential, config);

    return withCompletion(response, (failed) => complete(response.status, failed));
  } catch {
    complete(502);

    return failure(502, "upstream_unavailable");
  }
});

async function credentialsAvailable(env: Env, integrations: Integration[]): Promise<boolean> {
  const source = workerSecretSource(env);

  const resolved = await Promise.all(
    integrations.map(({ credential }) => source.resolve(credential)),
  );

  return resolved.every(
    (credential) =>
      credential && (credential.expiresAt === undefined || credential.expiresAt > Date.now()),
  );
}

async function readGrantRequest(request: Request) {
  if (!request.headers.get("content-type")?.match(/^application\/json(?:;|$)/i)) return;
  const reader = request.body?.getReader();

  if (!reader) return;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const maxBytes = 4_096;
  let size = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;

      if (size > maxBytes) {
        await reader.cancel();

        return;
      }

      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Malformed UTF-8 and JSON share the same client-facing error.
  } finally {
    reader.releaseLock();
  }
}

function registry(context: WorkerContext) {
  return context.env.REGISTRY.getByName(registryName);
}

export default app;
