# Beachside credential broker

The broker lets a sandbox clone and push GitHub repositories, use GitHub CLI, and call model APIs with expiring grants. You deploy the broker in your Cloudflare account. The Worker injects the upstream credentials from its secret bindings after authorizing each request against a SQLite-backed Durable Object. A sandbox receives only a grant, along with instructions for reaching the broker.

## Deploy

Use Bun 1.3.14, a Cloudflare account with Workers, and credentials for provisioning a Worker, its secrets, and a SQLite Durable Object namespace. From the repository root, run `bun install --frozen-lockfile`. Change into `services/credential-broker` before running Alchemy.

Save an operator-owned JSON configuration somewhere outside version control. Integration IDs are the names used in grant requests. The binding names below identify secrets and can be included in configuration files.

```json
{
  "integrations": [
    {
      "id": "github",
      "kind": "github",
      "credential": { "source": "worker-secret", "binding": "CREDENTIAL_GITHUB" }
    },
    {
      "id": "openai",
      "kind": "openai",
      "credential": { "source": "worker-secret", "binding": "CREDENTIAL_OPENAI" }
    }
  ],
  "githubActions": {
    "audience": "https://broker.example.com/github-actions",
    "workflows": [
      {
        "repositoryId": "123456789",
        "repositoryOwnerId": "23456789",
        "repository": "example-org/review-service",
        "ref": "refs/heads/main",
        "workflowRef": "example-org/review-service/.github/workflows/review.yml@refs/heads/main",
        "event": "pull_request_target",
        "integrations": ["github", "openai"]
      }
    ]
  }
}
```

The supported integration kinds are `github`, `anthropic`, `openai`, and `openrouter`. Configure up to 16 integrations. Git and GitHub CLI use the broker hostname, so each broker has at most one GitHub integration. Adding GitHub to a grant delegates the repository access and GraphQL permissions of its upstream token. Use a token scoped to the repositories and operations the sandbox needs.

Provide the following environment values to Alchemy through your secret manager or a local environment file kept out of version control.

| Variable | Value |
| --- | --- |
| `BROKER_CONFIG` | Operator configuration JSON |
| `CREDENTIAL_…` | One upstream API credential for each named binding |
| `BROKER_API_KEY` | Optional base64url management key generated with at least 32 random bytes |
| `ALCHEMY_PASSWORD` | Passphrase that encrypts secrets in Alchemy state. Keep it and the state directory private and available for updates. |
| `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` | Cloudflare provisioning credentials |

Configure an API key, GitHub Actions OIDC, or both. Run `bun run alchemy deploy` from this directory. Use the resulting Worker HTTPS origin as the broker URL. Preserve the Alchemy stage and its state when updating the service so the deployment keeps its grant registry. Each deployment has its own registry. Run `bun run db:generate -- --name your_change` after editing the Drizzle schema, and commit the generated SQL, journal, snapshot and bundled migration index. The Durable Object applies pending migrations when it starts.

## Authenticate the orchestrator

For API key authentication, provide `BROKER_API_KEY` as a bearer token on management requests. The key can issue grants for any configured integration and revoke any grant on that deployment. Keep it in the orchestrator process.

For GitHub Actions, give the trusted orchestration job `id-token: write` and request a GitHub Actions identity token for the exact configured audience. The [credential client](../../packages/credential-client/README.md) provides a helper that uses the runner's identity token endpoint. Pick an audience unique to this deployment. The broker verifies GitHub's signature, issuer, exact audience, expiry, token age, immutable repository and owner IDs, repository name, workflow path and ref, and event. Each workflow may grant its listed integrations and revoke grants issued within the same repository workflow run.

Supported workflow events are `push`, `schedule`, `workflow_dispatch`, `workflow_run`, and `pull_request_target`. For reusable workflows, configure the exact `jobWorkflowRef`; omit it for a direct workflow job. Only trust a ref controlled by the operators of the broker. For `pull_request_target` and `workflow_run`, keep PR-controlled code, actions, scripts, and artifacts out of the orchestration job. Pass untrusted work into the sandbox after issuing its limited grant. A fork's `pull_request` job cannot satisfy the policy.

## Grant API

| Request | Result |
| --- | --- |
| `POST /v1/grants` | Create a grant with body `{ "integrations": ["github"], "ttlSeconds": 900 }`. The response is `201` and has `id`, `token`, `expiresAt` (ISO 8601), and `integrations`. |
| `DELETE /v1/grants/:id` | Revoke under the issuing workflow run or the management key. Repeated requests return `204`. |

Grants last between 1 and 3,600 seconds. A grant can use its selected integrations immediately and cannot manage grants. The operation is authorized again for every gateway request. Revocation and expiry reject new requests. Requests that have already passed authorization, including active model streams and writes, may finish. A lost response to grant creation may leave a record until its expiry, and the broker cannot recover the raw grant token.

By default the registry admits up to 1,000 active grants and up to 100 per issuing authority (one management key or one workflow run). Each grant allows 120 requests per UTC minute and eight concurrent gateway requests, including streams. A lost lease release can occupy a slot until expiry. A request over a bound receives HTTP `429`. Set provider-side token scopes, spend limits, and quotas to constrain delegated use.

## Use the gateways

Use the [credential client](../../packages/credential-client/README.md) for Beachside-managed environment variables and revocation. It gives each opted-in sandbox a distinct grant. The client also works outside Beachside, where its caller owns revocation.

- **Git HTTPS** uses the broker remote `https://<broker-host>/<owner>/<repo>.git` and the grant password with username `x-access-token`. The client configures Git to rewrite `https://github.com/` remotes in the sandbox's command environment. Clone, fetch and push are supported over smart HTTP. SSH, Git LFS, and submodules on unrelated hosts use their own access paths.
- **GitHub CLI** uses `GH_HOST=<broker-host>` and `GH_ENTERPRISE_TOKEN=<grant>`. Give commands an explicit `--repo <broker-host>/<owner>/<repo>` if local remotes might resolve to another host. The broker maps GHES-style REST and GraphQL URLs to GitHub.com. Repo view, issue list/create, and PR list/create/comment have CLI fixtures. Canonical links returned by GitHub still point to GitHub.com. Browser views, auth login, workflows, releases, downloads, and endpoints outside the REST allowlist may require direct access. GraphQL forwards the queries and mutations allowed by the GitHub token.
- **Anthropic** uses `ANTHROPIC_BASE_URL=https://<broker-host>/gateway/<integration>` and `ANTHROPIC_API_KEY=<grant>`. The gateway supports messages, token counts, and model metadata.
- **OpenAI** and **OpenRouter** use `OPENAI_BASE_URL` or `OPENROUTER_BASE_URL` ending in `/gateway/<integration>/v1`. Supply the grant in the respective `*_API_KEY`. The gateway forwards model metadata, chat completions, responses creation, and embeddings where the upstream provider supports them. Files, key management, account endpoints, realtime WebSockets, and retrieval of stored responses are outside this gateway.

The reverse gateway has a fixed upstream per integration kind. It filters request and response headers, forwards permitted requests with the upstream credential, and streams bodies and server-sent events. It can rewrite same-upstream read redirects and REST pagination links back through the gateway. Other redirects are rejected. The broker sends each write once. A transport error may still leave an upstream write applied.

### OpenCode

In OpenCode v2, point a selected API-key provider's `settings.baseURL` and `settings.apiKey` at the environment provided by the credential client. Use the provider's HTTP transport. For example, put this in the sandbox's OpenCode configuration when using the OpenAI integration.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "openai": {
      "settings": {
        "baseURL": "{env:OPENAI_BASE_URL}",
        "apiKey": "{env:OPENAI_API_KEY}",
        "transport": "http"
      }
    }
  }
}
```

Use the corresponding environment variables for Anthropic or OpenRouter. In OpenCode v1, provider settings live under `provider.<id>.options`. These recipes use API keys and HTTP model endpoints. [OpenCode provider configuration](https://opencode.ai/docs/providers/)

## Observability and trust

Set `BROKER_OTLP_TRACES_ENDPOINT` to a trusted HTTPS OTLP/HTTP traces endpoint, such as `https://collector.example.com/v1/traces`, to export safe broker spans. If the collector needs authentication, supply the complete Authorization value in `BROKER_OTLP_AUTHORIZATION` as a Worker secret. Management requests can propagate trusted W3C trace context. Authorized gateway requests link to the issuing trace when available. The broker discards guest trace context and does not propagate broker trace headers to upstreams. Telemetry delivery is best effort. The deployment disables automatic invocation logging and native HTTP tracing to keep caller-supplied paths, query strings, and payloads out of telemetry.

Any sandbox workload or provider infrastructure able to read a grant can use it until expiry or revocation. Grants are bearer credentials scoped to integrations and are not bound to an IP address, sandbox identity, or private network. Keep them out of logs, artifacts, environment dumps, and persistent sandbox files. The registry records token digests, expiry, grant scope, and optional trace correlation. It keeps upstream credentials in Worker secret bindings and uses them only at the configured services. This deployment trusts its operators, Cloudflare, and the upstream providers.

## Validate locally

Run `bun run test` in this directory. Tests start workerd on loopback with fixture upstreams, use local Git and GitHub CLI, and use OpenSSL to create a temporary loopback certificate. They run without Cloudflare credentials or upstream API accounts.
