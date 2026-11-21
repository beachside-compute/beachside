---
title: Use from the SDK
description: Request a credential-broker grant for a sandbox with the SDK, renew it, and wire model clients and OpenCode to it.
---

Install the client next to the SDK on the machine that creates sandboxes.

```sh
npm install beachside @beachside/credential-client
```

Create the broker client with the issuer key, and pass `broker.sandbox()` as the sandbox's `grant`.

```ts
import { createCredentialBroker } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: { apiKey: process.env.BEACHSIDE_BROKER_ISSUER_KEY! },
});

const result = await client.sandboxes.with(
  {
    network: "internet",
    grant: broker.sandbox({ integrations: ["github", "openrouter"], ttlSeconds: 3_600 }),
  },
  (box) => box.exec(["printenv", "OPENROUTER_BASE_URL"]),
);
```

Each integration's variables follow its kind, as in the CLI:

| Integration                                       | Variables                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| GitHub                                            | `git` and `gh` configuration. See [GitHub access](/docs/credential-broker/github/) |
| Anthropic, OpenAI or OpenRouter kind              | `ANTHROPIC_*`, `OPENAI_*` or `OPENROUTER_*`: `_BASE_URL` and `_API_KEY`            |
| HTTPS endpoint, which `integration setup` creates | `<ID>_BASE_URL` and `<ID>_API_KEY`, so `openrouter` sets `OPENROUTER_*`            |

To choose the names, list the integration in `endpoints` instead:

```ts
broker.sandbox({
  endpoints: [
    { integration: "openrouter", baseURLEnv: "OPENAI_BASE_URL", apiKeyEnv: "OPENAI_API_KEY" },
  ],
});
```

The base URL variable already includes the path the integration was registered with. For OpenRouter that is `.../gateway/openrouter`, standing for `https://openrouter.ai/api/v1`, so a client that appends `/chat/completions` works as is. Pass the broker URL explicitly to a client that does not read the variable.

## Lifetime and renewal

The SDK acquires the grant once the sandbox exists and before setup runs. It applies the variables to every command, process and terminal started through that client, including handles reopened on the same client. A handle reopened through a new connection, or a native SSH session, does not have them. When you need the grant in every process, from any client, use the CLI, which writes it into the sandbox's environment.

```ts
box.grant(); // { status: "active", id, integrations, env: [...names], expiresAt, renewable }
await box.renewGrant({ ttlSeconds: 7 * 24 * 3_600 });
```

The SDK's default lifetime is 15 minutes, and the broker allows up to 7 days. `renewGrant()` moves the expiry to `ttlSeconds` from now and keeps the token. After expiry or revocation, the handle stops starting commands. The broker checks each request on its own, so a process that already has the grant also stops working.

`box.destroy()` and the end of `sandboxes.with()` revoke the grant. So does a failed setup, even with `onSetupFailure: "keep"`. If revocation fails, `SandboxCredentialRevocationError` carries the destroy result, and the grant expires on schedule. Credentialed sandboxes cannot be snapshotted or forked, and `submitCreate()` refuses a grant.

A grant needs a network that reaches the broker. `network: "blocked"` is refused. See the [network notes](/docs/credential-broker/cli/#network-access) for providers that limit outbound traffic.

## Refused grants

If the broker refuses a grant, the error says why and how to fix it: an unknown integration, a disabled one, or one the issuer may not grant yet ("Run `beachside broker issuer allow openrouter`").

## OpenCode

OpenCode reads variable references in its configuration, so it can use the grant directly. Add the providers your grant includes to `opencode.json` or `.opencode/opencode.json` in the project. [OpenCode configuration](https://opencode.ai/docs/config/), [OpenCode providers](https://opencode.ai/docs/providers/).

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "openrouter": {
      "settings": {
        "baseURL": "{env:OPENROUTER_BASE_URL}",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      }
    }
  }
}
```

OpenCode v2.2.7 also takes the same JSON through `OPENCODE_CONFIG_CONTENT` in the environment of the command that starts it. Keep the `{env:...}` references. [OpenCode CLI environment variables](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/web/src/content/docs/cli.mdx#environment-variables).

![OpenCode v2 OpenRouter settings use {env:OPENROUTER_BASE_URL} for baseURL and {env:OPENROUTER_API_KEY} for apiKey. Pass the settings as inline JSON in OPENCODE_CONFIG_CONTENT.](/images/credential-broker/opencode-openrouter.png)

The [compiled OpenCode example](https://github.com/beachside-compute/beachside/blob/main/apps/docs/examples/credential-broker.ts) sets up both integrations, clones a project and starts OpenCode with the grant.

## GitHub Actions

On a GitHub Actions runner, issue grants with the job's OIDC token instead of an issuer key. See [GitHub Actions](/docs/credential-broker/github/#github-actions).
