---
title: Quickstart
description: Deploy the credential broker, add an OpenRouter key and call OpenRouter with a temporary grant, in about ten minutes.
---

This walks through one path end to end: deploy the broker to your Cloudflare account, add an OpenRouter key, and call OpenRouter with a grant instead of the key. It needs nothing from Beachside, so it works with any sandbox or orchestrator.

You need Bun 1.4.4, Node.js 22 or later, a Cloudflare account that can deploy Workers and SQLite Durable Objects, and an OpenRouter API key.

## 1. Deploy the broker

```sh
git clone https://github.com/beachside-compute/credential-broker.git
cd credential-broker
bun install --frozen-lockfile
bun run --cwd services/credential-broker wrangler login
```

On a remote machine without a browser, add `--device --browser=false` to the login and open the printed URL. [Wrangler sign-in options](https://developers.cloudflare.com/workers/wrangler/commands/general/#wrangler-login).

Generate the admin, issuer and encryption keys into a private `.env.deploy`, then deploy. Back the file up somewhere safe: it holds the only copy of the keys.

```sh
bun run deploy:setup
bun run deploy
```

Wrangler prints the broker's HTTPS origin. Add it to `.env.deploy`, so every later command finds the URL and keys in one file.

```sh
echo 'BEACHSIDE_BROKER_URL=https://beachside-credential-broker.your-subdomain.workers.dev' >> .env.deploy
```

The default `workers.dev` hostname works. To use your own domain, see [custom hostnames](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#use-a-custom-hostname).

## 2. Add OpenRouter

The checkout runs the broker's command line as `bun run broker`, with the URL and keys from `.env.deploy`.

```sh
bun run broker status
bun run broker integration setup
```

`status` confirms the URL and that the admin key works. In setup, choose OpenRouter, press Enter to keep the ID `openrouter`, and paste your OpenRouter key at the masked prompt. The broker stores the key encrypted and lets the issuer key grant `openrouter`.

## 3. Issue a grant and call OpenRouter

```sh
bun run broker grant issue openrouter --ttl 15m --label quickstart
```

The output shows the grant ID, its expiry, a base URL for `openrouter` and the token. The base URL is your broker standing in for `https://openrouter.ai/api/v1`, and the token is the API key to send it. Check that OpenRouter accepts it. This calls OpenRouter's [current key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), which uses no model tokens, and prints the HTTP status.

```sh
export OPENROUTER_BASE_URL=https://beachside-credential-broker.your-subdomain.workers.dev/gateway/openrouter
export OPENROUTER_API_KEY=bsg_...   # the token from the output
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $OPENROUTER_API_KEY" "$OPENROUTER_BASE_URL/key"
```

A `200` means the broker swapped the grant for your real key. Put the same two variables in a sandbox's environment and any OpenAI-compatible client there reaches OpenRouter without ever holding the key. When the work is done, cut the grant off early:

```sh
bun run broker grant revoke <grant-id>
```

## Use it from somewhere else

`bun run broker` works inside the checkout. Elsewhere, use one of these. Both take the same commands, such as `grant issue` and `integration setup`.

**Another machine, script or CI job:** install the standalone `beachside-broker` command and give it the URL and a key from `.env.deploy`. A machine that only issues grants needs just the issuer key.

```sh
npm install -g @beachside/credential-client
export BEACHSIDE_BROKER_URL=https://beachside-credential-broker.your-subdomain.workers.dev
export BEACHSIDE_BROKER_ISSUER_KEY=...   # BROKER_ISSUER_KEY from .env.deploy
beachside-broker grant issue openrouter --ttl 1h
```

**Already using the `beachside` CLI:** save the broker once, then create sandboxes with grants. `rm` destroys the sandbox and revokes its grant. See [use from the CLI](/docs/credential-broker/cli/).

```sh
beachside broker add work --deployment .env.deploy
beachside create --name agent --network internet --grant openrouter
beachside rm agent
```

## Next steps

- [Use from the CLI](/docs/credential-broker/cli/): longer grants for always-on agents, renewal, and other integrations.
- [Use from the SDK](/docs/credential-broker/sdk/).
- [GitHub access](/docs/credential-broker/github/) for `git` and `gh` in sandboxes.
- [Model gateway recipes](/docs/credential-broker/model-gateways/) for Kilo, Cloudflare, Vercel, OpenAI and Anthropic.
