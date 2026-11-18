import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { isBrokerApiKey } from "./src/auth/api-key";
import { parseConfig } from "./src/config";
import { traceAuthorization, traceEndpoint } from "./src/observability/otlp";
import type { TraceExportBindings } from "./src/observability/otlp";

const compatibilityDate = "2026-11-18";

const config = parseConfig(alchemy.env("BROKER_CONFIG"));

const key = process.env.BROKER_API_KEY;

if (key !== undefined && !isBrokerApiKey(key)) {
  throw new Error(
    "BROKER_API_KEY must be a random 32–256 character base64url value outside the reserved grant-token format",
  );
}

if (!key && !config.githubActions) {
  throw new Error("Configure a broker API key, GitHub Actions OIDC, or both");
}

const traceUrl = process.env.BROKER_OTLP_TRACES_ENDPOINT;

const tracesEndpoint = traceUrl === undefined ? undefined : traceEndpoint(traceUrl);

const collectorAuthorization = process.env.BROKER_OTLP_AUTHORIZATION;

if (collectorAuthorization !== undefined) traceAuthorization(collectorAuthorization);

const app = await alchemy("beachside-credential-broker", {
  password: alchemy.env("ALCHEMY_PASSWORD"),
  noTrack: true,
});

const registry = DurableObjectNamespace("grant-registry", {
  className: "GrantRegistry",
  sqlite: true,
});

const secretBindings = Object.fromEntries(
  config.integrations.map(({ credential }) => [
    credential.binding,
    alchemy.secret.env(credential.binding),
  ]),
);

if (key) secretBindings.BROKER_API_KEY = alchemy.secret(key, "BROKER_API_KEY");

if (tracesEndpoint && collectorAuthorization !== undefined) {
  secretBindings.BROKER_OTLP_AUTHORIZATION = alchemy.secret(
    collectorAuthorization,
    "BROKER_OTLP_AUTHORIZATION",
  );
}

const traceVars: Pick<TraceExportBindings, "BROKER_OTLP_TRACES_ENDPOINT"> = {};

if (tracesEndpoint) traceVars.BROKER_OTLP_TRACES_ENDPOINT = tracesEndpoint;

export const worker = await Worker("broker", {
  cwd: import.meta.dir,
  entrypoint: "./src/index.ts",
  bundle: { loader: { ".sql": "text" } },
  compatibilityDate,
  url: true,
  // Native invocation logs and fetch traces can record full URLs supplied by callers.
  observability: {
    enabled: false,
    logs: { enabled: false, invocationLogs: false },
    traces: { enabled: false },
  },
  bindings: {
    ...secretBindings,
    ...traceVars,
    BROKER_CONFIG: JSON.stringify(config),
    REGISTRY: registry,
  },
});

console.info(worker.url);

await app.finalize();
