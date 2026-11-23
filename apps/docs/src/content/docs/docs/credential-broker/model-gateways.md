---
title: Model gateway recipes
description: Connect sandbox model clients to HTTPS APIs through short-lived credential broker grants.
---

These recipes use the [`beachside` CLI](/docs/credential-broker/cli/) with a [connected broker](/docs/credential-broker/cli/#connect-a-broker). Every management command here also runs as `beachside-broker` or, in the broker checkout, `bun run broker`. [The three forms](/docs/credential-broker/quickstart/#4-run-the-same-commands-anywhere).

Start the setup wizard.

```sh
beachside broker integration setup
```

Select OpenRouter, Kilo AI Gateway, Cloudflare AI Gateway (OpenAI provider), Vercel AI Gateway, OpenAI, Anthropic, or Custom HTTPS endpoint. Enter an integration ID, or press Enter for the suggested one, and the requested upstream values. Every preset creates an HTTPS endpoint integration and allows grants for it. The Cloudflare preset asks for the gateway destination and both credentials. The custom option lets you enter your own URL and headers.

A sandbox with a grant for an HTTPS endpoint gets `<ID>_BASE_URL` and `<ID>_API_KEY`, so the suggested IDs give the variables those clients usually read: `openrouter` sets `OPENROUTER_*`, `openai` sets `OPENAI_*`, `anthropic` sets `ANTHROPIC_*`.

An integration fixes the upstream base URL and the headers the broker sets. A grant covers the entire path beneath that base URL, subject to the proxy's request checks and the upstream credential's permissions. Use an upstream and DNS configuration you trust, and use keys with the permissions you intend to delegate. The broker checks URL and hostname syntax. A hostname can pass those checks and still resolve to a private IP address.

The broker applies best-effort filtering to credential reflections in response headers and streams the upstream response body unchanged. Use destinations that keep credentials out of response bodies and encoded or otherwise transformed response headers.

Use an HTTPS request/response API whose authentication fits fixed headers. The broker stores secret header values in its encrypted store and injects them on each request. OAuth token refresh, request signing, WebSocket upgrades, and HTTP CONNECT are outside this interface.

## Noninteractive setup

Each recipe uses Node.js to read upstream secrets from exported variables on your machine and passes the configuration to the CLI over stdin. `--allow-issue` lets the issuer grant the new integration right away.

### OpenRouter

Export `OPENROUTER_API_KEY`. This base URL works with clients that append `/chat/completions`. [OpenRouter authentication](https://openrouter.ai/docs/api/reference/authentication).

```sh
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: "https://openrouter.ai/api/v1",
    headers: [{ name: "Authorization", secret: true, prefix: "Bearer " }]
  },
  credential: { source: "encrypted-store", values: {
    Authorization: process.env.OPENROUTER_API_KEY
  } }
}))' | beachside broker integration create openrouter --provider http --config-stdin --allow-issue
```

### Kilo AI Gateway

Export `KILO_API_KEY`. If you use an organization-scoped key, supply the appropriate `X-KiloCode-OrganizationId` header for your account. [Kilo AI Gateway](https://kilo.ai/docs/gateway) and [Kilo authentication](https://kilo.ai/docs/gateway/authentication).

```sh
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: "https://ai-gateway.kilo.ai/api/v1",
    headers: [{ name: "Authorization", secret: true, prefix: "Bearer " }]
  },
  credential: { source: "encrypted-store", values: {
    Authorization: process.env.KILO_API_KEY
  } }
}))' | beachside broker integration create kilo --provider http --config-stdin --allow-issue
```

### Cloudflare AI Gateway

This recipe uses Cloudflare's provider-native OpenAI endpoint. Export `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`, `CLOUDFLARE_API_TOKEN` with the gateway's Run permission, and `OPENAI_API_KEY` for OpenAI. The broker strips sandbox-supplied `cf-*` headers and sends the two keys using the configured `Authorization` and `cf-aig-authorization` headers. The sandbox client only supplies its grant for authentication. [Cloudflare authenticated gateways](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and [Cloudflare OpenAI endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/).

```sh
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}" "${CLOUDFLARE_GATEWAY_ID:?Set CLOUDFLARE_GATEWAY_ID}"
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: `https://gateway.ai.cloudflare.com/v1/${process.env.CLOUDFLARE_ACCOUNT_ID}/${process.env.CLOUDFLARE_GATEWAY_ID}/openai`,
    headers: [
      { name: "Authorization", secret: true, prefix: "Bearer " },
      { name: "cf-aig-authorization", secret: true, prefix: "Bearer " }
    ]
  },
  credential: { source: "encrypted-store", values: {
    Authorization: process.env.OPENAI_API_KEY,
    "cf-aig-authorization": process.env.CLOUDFLARE_API_TOKEN
  } }
}))' | beachside broker integration create cloudflare --provider http --config-stdin --allow-issue
```

### Vercel AI Gateway

Export `AI_GATEWAY_API_KEY`. The `/v1` base serves OpenAI Chat Completions and Responses clients. [Vercel AI Gateway SDKs and APIs](https://vercel.com/docs/ai-gateway/sdks-and-apis).

```sh
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: "https://ai-gateway.vercel.sh/v1",
    headers: [{ name: "Authorization", secret: true, prefix: "Bearer " }]
  },
  credential: { source: "encrypted-store", values: {
    Authorization: process.env.AI_GATEWAY_API_KEY
  } }
}))' | beachside broker integration create vercel --provider http --config-stdin --allow-issue
```

### OpenAI

Export `OPENAI_API_KEY`. Use the broker URL as the OpenAI SDK's `baseURL` and the temporary grant as its `apiKey`. [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication).

```sh
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: "https://api.openai.com/v1",
    headers: [{ name: "Authorization", secret: true, prefix: "Bearer " }]
  },
  credential: { source: "encrypted-store", values: {
    Authorization: process.env.OPENAI_API_KEY
  } }
}))' | beachside broker integration create openai --provider http --config-stdin --allow-issue
```

### Anthropic

Export a workspace-scoped `ANTHROPIC_API_KEY`. The Anthropic SDK appends `/v1/messages` and supplies the `anthropic-version` header. Use the broker URL as the SDK's `baseURL` and the grant as its `apiKey`. The wizard preset sets a fixed `anthropic-version` of `2023-06-01`. Use the recipe below to let the client set the version, or add your chosen version as a literal header. [Anthropic API authentication](https://platform.claude.com/docs/en/api/overview#authentication).

```sh
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: "https://api.anthropic.com",
    headers: [{ name: "x-api-key", secret: true }]
  },
  credential: { source: "encrypted-store", values: {
    "x-api-key": process.env.ANTHROPIC_API_KEY
  } }
}))' | beachside broker integration create anthropic --provider http --config-stdin --allow-issue
```

### Custom HTTPS endpoint

Replace the example base URL and headers and export `PARTNER_API_KEY`. Use an HTTPS URL of up to 2,048 characters with a multi-label DNS hostname and an optional path prefix. Leave credentials, query parameters, and fragments out of the base URL. IP literals and names ending in `.local`, `.localhost`, `.internal`, `.test`, `.invalid`, or `.example` are rejected.

The base path and request path must use well-formed segments. The broker rejects dot segments, repeated slashes, backslashes, malformed escapes, and encoded slashes, backslashes, or percent signs. It also rejects segments that decode to a value containing a semicolon or ending in a dot or whitespace.

A literal header uses `value` and appears in the integration metadata. A secret header uses `secret: true` and takes its value from `credential.values`, keyed by header name. The optional `prefix` precedes a secret, as in the Bearer examples. For a literal-only integration, pass an empty `values` object. Configured headers override matching headers from the sandbox request.

```sh
node -e 'console.log(JSON.stringify({
  endpoint: {
    baseURL: "https://api.example.com/v2",
    headers: [
      { name: "x-partner-key", secret: true },
      { name: "x-api-version", value: "2026-01-01" }
    ]
  },
  credential: { source: "encrypted-store", values: {
    "x-partner-key": process.env.PARTNER_API_KEY
  } }
}))' | beachside broker integration create partner --provider http --config-stdin --allow-issue
```

## Use the endpoint in a sandbox

Grant the integration by ID. To give an OpenAI-compatible client the variables it reads, name them after the ID.

```sh
beachside create --name agent --network internet --grant openrouter=OPENAI_BASE_URL,OPENAI_API_KEY
```

From the SDK, the same mapping is an `endpoints` entry:

```ts
const grant = broker.sandbox({
  endpoints: [
    { integration: "openrouter", baseURLEnv: "OPENAI_BASE_URL", apiKeyEnv: "OPENAI_API_KEY" },
  ],
});
```

Run the request inside the sandbox. For `openrouter`, the broker maps the request to `https://openrouter.ai/api/v1/chat/completions` and replaces the grant with the stored OpenRouter key. Set a model ID supported by your upstream when using a different integration. [OpenRouter model example](https://openrouter.ai/openai/gpt-5-mini).

```sh
curl --fail-with-body "$OPENAI_BASE_URL/chat/completions" \
  --header "Authorization: Bearer $OPENAI_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "openai/gpt-5-mini",
    "messages": [{ "role": "user", "content": "Summarize what a sandbox does in one sentence." }]
  }'
```

## Rotate a secret header

Export the replacement secret on your machine and pipe the header value map to the CLI. You can rotate one secret header at a time in a multi-secret integration. Configure a new integration when the destination or header definitions need to change.

```sh
node -e 'console.log(JSON.stringify({
  Authorization: process.env.REPLACEMENT_OPENROUTER_API_KEY
}))' | beachside broker integration rotate openrouter --credentials-stdin
```
