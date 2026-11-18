/* oxlint-disable anti-slop/no-runtime-typeof -- Validate broker responses and credentials at the HTTP trust boundary. */

export type CredentialBrokerAuth =
  | { apiKey: string }
  | { githubActionsOidc: (signal: AbortSignal) => Promise<string> };

type Fetch = (request: Request) => Promise<Response>;

interface BrokerRequestOptions {
  signal?: AbortSignal;
  /** Optional W3C trace context for the trusted broker only. */
  traceParent?: string;
}

export interface CredentialBrokerOptions {
  url: string;
  auth: CredentialBrokerAuth;
  fetch?: Fetch;
}

export interface BrokerGrantRequest {
  integrations: readonly string[];
  ttlSeconds?: number;
}

export interface BrokerGrant {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly integrations: readonly string[];
}

export interface SandboxIntegrations {
  github?: string;
  anthropic?: string;
  openai?: string;
  openrouter?: string;
  ttlSeconds?: number;
}

export interface SandboxGrant {
  readonly env: Readonly<Record<string, string>>;
  readonly expiresAt: string;
  revoke(signal: AbortSignal, traceParent?: string): Promise<void>;
}

export class CredentialBrokerError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARGUMENT"
      | "INVALID_RESPONSE"
      | "UNAUTHENTICATED"
      | "FORBIDDEN"
      | "RATE_LIMIT"
      | "TIMEOUT"
      | "WAIT_ABORTED"
      | "UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "CredentialBrokerError";
  }
}

const defaultFetch: Fetch = (request) => fetch(request);

const integrationName = /^[a-z][a-z0-9-]{0,31}$/;

const grantId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sandboxToken = /^bsg_[a-f0-9]{64}$/;

const bearerToken = /^[A-Za-z0-9._~+/-]{1,16384}={0,2}$/;

const apiKey = /^[A-Za-z0-9_-]{32,256}$/;

const traceParentPattern = /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-0[01]$/;

const requestTimeout = 10_000;

function httpsURL(input: string): URL {
  try {
    const url = new URL(input);

    if (url.protocol === "https:" && !url.username && !url.password && !url.hash) return url;
  } catch {
    // The native parse error can echo a URL or included credentials.
  }

  throw new CredentialBrokerError("INVALID_ARGUMENT", "A valid HTTPS URL is required");
}

function validateRequest({ integrations, ttlSeconds = 900 }: BrokerGrantRequest) {
  if (
    !Array.isArray(integrations) ||
    !integrations.length ||
    integrations.length > 16 ||
    integrations.some((id) => typeof id !== "string" || !integrationName.test(id)) ||
    new Set(integrations).size !== integrations.length ||
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 3600
  )
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant request");

  return { integrations: [...integrations], ttlSeconds };
}

async function jsonRecord(response: Response) {
  try {
    const data: unknown = await response.json();

    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // A broker or runner response body can contain credentials. Do not attach the parse error.
  }

  throw new CredentialBrokerError("INVALID_RESPONSE", "Credential endpoint returned invalid JSON");
}

async function fetchRequest(
  transport: Fetch,
  url: URL,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  try {
    return await waitForSignal(init.signal, () =>
      transport(new Request(url, { ...init, redirect: "error" })),
    );
  } catch {
    if (init.signal.aborted)
      throw new CredentialBrokerError("WAIT_ABORTED", "Credential request was cancelled");

    throw new CredentialBrokerError("UNAVAILABLE", "Credential endpoint is unavailable");
  }
}

function assertStatus(response: Response, expected: number) {
  if (response.status === expected) return;
  void response.body?.cancel().catch(() => undefined);

  switch (response.status) {
    case 401:
      throw new CredentialBrokerError(
        "UNAUTHENTICATED",
        "Credential endpoint rejected authentication",
      );
    case 403:
      throw new CredentialBrokerError("FORBIDDEN", "Credential request was denied");
    case 429:
      throw new CredentialBrokerError(
        "RATE_LIMIT",
        "Credential endpoint is rate limiting requests",
      );
    default:
      throw new CredentialBrokerError(
        "UNAVAILABLE",
        "Credential endpoint could not complete request",
      );
  }
}

async function waitForSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new CredentialBrokerError("WAIT_ABORTED", "Credential request was cancelled"));

    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        if (signal.aborted) return;

        return work().then(resolve, reject);
      })
      .catch(reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function withRequestSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(requestTimeout);

  return { timeout, signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

/** Resolve a fresh GitHub Actions identity token per broker request. Run on the trusted host. */
export function githubActionsOidc(options: {
  audience: string;
  env: { ACTIONS_ID_TOKEN_REQUEST_URL?: string; ACTIONS_ID_TOKEN_REQUEST_TOKEN?: string };
  fetch?: Fetch;
}): CredentialBrokerAuth {
  const { audience, env, fetch: transport = defaultFetch } = options;
  const url = httpsURL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "";

  if (!audience || !bearerToken.test(token))
    throw new CredentialBrokerError(
      "INVALID_ARGUMENT",
      "GitHub Actions OIDC configuration is incomplete",
    );

  url.searchParams.set("audience", audience);

  return {
    async githubActionsOidc(signal) {
      const response = await fetchRequest(transport, url, {
        signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });

      assertStatus(response, 200);

      const reply = await waitForSignal(signal, () => jsonRecord(response));

      if (!("value" in reply) || typeof reply.value !== "string" || !bearerToken.test(reply.value))
        throw new CredentialBrokerError(
          "INVALID_RESPONSE",
          "GitHub Actions returned an invalid identity token",
        );

      return reply.value;
    },
  };
}

/** Trusted-host client. Management authentication stays in this client. */
export function createCredentialBroker(options: CredentialBrokerOptions) {
  const base = httpsURL(options.url);

  if (base.pathname !== "/" || base.search)
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Use the credential broker HTTPS origin");

  const transport = options.fetch ?? defaultFetch;
  const auth = { ...options.auth };

  if (
    "apiKey" in auth &&
    (typeof auth.apiKey !== "string" || !apiKey.test(auth.apiKey) || sandboxToken.test(auth.apiKey))
  )
    throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker API key");

  async function management(
    path: string,
    method: "POST" | "DELETE",
    expected: 201 | 204,
    signal: AbortSignal,
    traceParent?: string,
    body?: string,
  ) {
    let token: string;

    try {
      token =
        "apiKey" in auth
          ? auth.apiKey
          : await waitForSignal(signal, () => auth.githubActionsOidc(signal));
    } catch {
      if (signal.aborted)
        throw new CredentialBrokerError("WAIT_ABORTED", "Credential authentication was cancelled");
      throw new CredentialBrokerError("UNAUTHENTICATED", "Credential broker authentication failed");
    }

    if (typeof token !== "string" || !bearerToken.test(token))
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker authentication");

    const response = await fetchRequest(transport, new URL(path, base), {
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body && { "content-type": "application/json" }),
        ...(traceParent && traceParentPattern.test(traceParent) && { traceparent: traceParent }),
      },
      body,
    });

    assertStatus(response, expected);

    return response;
  }

  async function issue(
    request: BrokerGrantRequest,
    options: BrokerRequestOptions = {},
  ): Promise<BrokerGrant> {
    const body = validateRequest(request);
    const budget = withRequestSignal(options.signal);

    try {
      const response = await management(
        "/v1/grants",
        "POST",
        201,
        budget.signal,
        options.traceParent,
        JSON.stringify(body),
      );

      const reply = await waitForSignal(budget.signal, () => jsonRecord(response));

      if (!("id" in reply && "token" in reply && "expiresAt" in reply && "integrations" in reply))
        throw new CredentialBrokerError(
          "INVALID_RESPONSE",
          "Credential broker returned an invalid grant",
        );
      const { id, token, expiresAt, integrations } = reply;

      if (
        typeof id !== "string" ||
        !grantId.test(id) ||
        typeof token !== "string" ||
        !sandboxToken.test(token) ||
        typeof expiresAt !== "string" ||
        !Number.isFinite(Date.parse(expiresAt)) ||
        !Array.isArray(integrations) ||
        integrations.length !== body.integrations.length ||
        !body.integrations.every((name) => integrations.includes(name))
      )
        throw new CredentialBrokerError(
          "INVALID_RESPONSE",
          "Credential broker returned an invalid grant",
        );

      return { id, token, expiresAt, integrations: body.integrations };
    } catch (error) {
      if (options.signal?.aborted)
        throw new CredentialBrokerError("WAIT_ABORTED", "Credential grant request was cancelled");

      if (budget.timeout.aborted)
        throw new CredentialBrokerError("TIMEOUT", "Credential grant request timed out");
      throw error;
    }
  }

  async function revoke(id: string, options: BrokerRequestOptions = {}): Promise<void> {
    if (typeof id !== "string" || !grantId.test(id))
      throw new CredentialBrokerError("INVALID_ARGUMENT", "Invalid broker grant identifier");
    const budget = withRequestSignal(options.signal);

    try {
      await management(`/v1/grants/${id}`, "DELETE", 204, budget.signal, options.traceParent);
    } catch (error) {
      if (options.signal?.aborted)
        throw new CredentialBrokerError(
          "WAIT_ABORTED",
          "Credential revocation request was cancelled",
        );

      if (budget.timeout.aborted)
        throw new CredentialBrokerError("TIMEOUT", "Credential revocation request timed out");
      throw error;
    }
  }

  function sandbox({ github, anthropic, openai, openrouter, ttlSeconds }: SandboxIntegrations) {
    const integrations = [github, anthropic, openai, openrouter].filter((id) => id !== undefined);
    const request = validateRequest({ integrations, ttlSeconds });

    return {
      async acquire(signal: AbortSignal, traceParent?: string): Promise<SandboxGrant> {
        const grant = await issue(request, { signal, traceParent });
        const env: Record<string, string> = {};
        const gateway = (id: string) => `${base.origin}/gateway/${id}`;

        if (github !== undefined) {
          env.GH_HOST = base.host;
          env.GH_ENTERPRISE_TOKEN = grant.token;
          env.GIT_CONFIG_COUNT = "3";
          env.GIT_CONFIG_KEY_0 = `credential.${base.origin}/.helper`;
          env.GIT_CONFIG_VALUE_0 = "";
          env.GIT_CONFIG_KEY_1 = env.GIT_CONFIG_KEY_0;
          env.GIT_CONFIG_VALUE_1 =
            '!f() { if test "$1" = get; then printf "%s\\n" username=x-access-token "password=$GH_ENTERPRISE_TOKEN"; fi; }; f';
          env.GIT_CONFIG_KEY_2 = `url.${base.origin}/.insteadOf`;
          env.GIT_CONFIG_VALUE_2 = "https://github.com/";
          env.GIT_TERMINAL_PROMPT = "0";
        }

        if (anthropic !== undefined) {
          env.ANTHROPIC_BASE_URL = gateway(anthropic);
          env.ANTHROPIC_API_KEY = grant.token;
        }

        if (openai !== undefined) {
          env.OPENAI_BASE_URL = `${gateway(openai)}/v1`;
          env.OPENAI_API_KEY = grant.token;
        }

        if (openrouter !== undefined) {
          env.OPENROUTER_BASE_URL = `${gateway(openrouter)}/v1`;
          env.OPENROUTER_API_KEY = grant.token;
        }

        return {
          env,
          expiresAt: grant.expiresAt,
          revoke: (signal, traceParent) => revoke(grant.id, { signal, traceParent }),
        };
      },
    };
  }

  return { issue, revoke, sandbox };
}
