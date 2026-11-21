---
title: Quickstart
description: Deploy the credential broker, add OpenRouter, and call it from a sandbox with a grant, in about ten minutes.
---

This walks through one path end to end: deploy the broker to Cloudflare, connect the `beachside` CLI to it, add an OpenRouter key, and use it from a sandbox that never sees that key.

You need Bun 1.4.4, Node.js 22 or later, a Cloudflare account that can deploy Workers and SQLite Durable Objects, an OpenRouter API key, and the [`beachside` CLI](/docs/cli/) with a working profile.

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

Wrangler prints the broker's HTTPS origin. Add it to `.env.deploy` so the next step finds everything in one file.

```sh
echo 'BEACHSIDE_BROKER_URL=https://beachside-credential-broker.your-subdomain.workers.dev' >> .env.deploy
```

The default `workers.dev` hostname works. To use your own domain, see [custom hostnames](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#use-a-custom-hostname).

## 2. Connect the CLI

```sh
beachside broker add work --deployment .env.deploy
```

The CLI asks the broker which role each key has before it saves them, then stores the URL and keys in `beachside.json` and makes `work` the default broker. To keep the keys in a password manager instead, pass references: `--url https://... --issuer-key op://infra/broker/issuer --admin-key op://infra/broker/admin`.

```sh
beachside broker status
```

## 3. Add OpenRouter

```sh
beachside broker integration setup
```

Choose OpenRouter, press Enter to keep the ID `openrouter`, and paste your OpenRouter key at the masked prompt. Setup stores the key encrypted in the broker and allows grants for `openrouter`.

## 4. Give a sandbox a grant

```sh
beachside create --name agent --network internet --grant openrouter
```

The sandbox now has `OPENROUTER_BASE_URL`, pointing at your broker, and `OPENROUTER_API_KEY`, holding the grant. Check that OpenRouter accepts it. This calls OpenRouter's [current key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), which uses no model tokens, and prints the HTTP status. The sandbox image needs `curl`.

```sh
beachside exec agent -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $OPENROUTER_API_KEY" "$OPENROUTER_BASE_URL/key"'
```

A `200` means the broker swapped the grant for your real key. Any OpenAI-compatible client in the sandbox can use the same two variables.

## 5. Clean up

```sh
beachside inspect agent
beachside rm agent
```

`inspect` shows the grant's integrations, variables and expiry. `rm` destroys the sandbox and revokes the grant.

## Next steps

- [Use from the CLI](/docs/credential-broker/cli/): longer grants for always-on agents, renewal, and other integrations.
- [Use from the SDK](/docs/credential-broker/sdk/).
- [GitHub access](/docs/credential-broker/github/) for `git` and `gh` in sandboxes.
