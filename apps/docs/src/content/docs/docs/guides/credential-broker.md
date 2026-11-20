---
title: Credential broker
description: Give sandbox commands short-lived GitHub and model access through a self-hosted credential broker.
---

Use the credential broker when a sandbox needs to call GitHub, OpenRouter, or another HTTPS API and you want to keep the real credential out of the sandbox and away from its provider. You run the broker in your Cloudflare account, where it stores the upstream keys encrypted.

## How it works

Beachside gives the sandbox a broker URL and a short-lived token called a **grant**. The grant only works with the integrations you approved for that sandbox. The broker checks the grant, swaps it for the real key on the upstream request, and relays the response. You can let a grant expire or revoke it early while keeping the upstream key in place for other workloads.

![A sandbox sends its temporary grant to your broker. The broker checks the grant, sends the real key to OpenRouter, and relays the response back to the sandbox.](/images/credential-broker/architecture.png)

## Deploy the broker

Deploying the Worker from source uses Bun 1.4.4, Node.js 22 or later, and a Cloudflare account that can deploy Workers and SQLite Durable Objects. Once deployed, manage the broker with the installed Node CLI.

```sh
git clone https://github.com/beachside-compute/credential-broker.git
cd credential-broker
bun install --frozen-lockfile
```

On a machine with a local browser, sign in with Wrangler.

```sh
bun run --cwd services/credential-broker wrangler login
```

On a remote machine, sign in with a device code. Open the printed URL and enter the code in your browser. [Wrangler sign-in options](https://developers.cloudflare.com/workers/wrangler/commands/general/#wrangler-login).

```sh
bun run --cwd services/credential-broker wrangler login --device --browser=false
```

Generate the admin, issuer, and encryption keys in a private `.env.deploy` file. Rerunning setup keeps the existing file. Back up the keys securely.

```sh
bun run deploy:setup
```

You can use the default `workers.dev` hostname or [configure a custom hostname](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#use-a-custom-hostname). Run the deployment and copy the HTTPS origin Wrangler prints.

```sh
bun run deploy
```

For unattended deployment, key rotation, or an existing Alchemy deployment, see the [broker runbook](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#deploy).

## Set up runtime integrations

Install the broker CLI on the operator machine with Node.js 22 or later.

```sh
npm install -g @beachside/credential-client
```

Set the deployed HTTPS origin and load the admin key from `.env.deploy` or your secret manager. In Bash or Zsh, paste the `BROKER_ADMIN_KEY` at the hidden prompt.

```sh
export BEACHSIDE_BROKER_URL=https://your-broker.example.com
printf 'Paste the broker admin key and press Enter: '
read -rs BEACHSIDE_BROKER_ADMIN_KEY
printf '\n'
export BEACHSIDE_BROKER_ADMIN_KEY
```

Open the integration wizard.

```sh
beachside-broker integration setup
```

Select OpenRouter, enter `router-work` as the integration ID, and paste the OpenRouter key in the masked prompt. Pressing Enter at the ID prompt uses `openrouter`. If you use that default, substitute it for `router-work` below. The same wizard supports other gateways and custom HTTPS endpoints. [Model gateway recipes](/docs/guides/model-gateways/).

Check which integrations the issuer can use.

```sh
beachside-broker issuer show
```

If the list is empty, allow grants for `router-work`. If the list already has IDs, pass them alongside `router-work`. The command replaces the entire list.

```sh
beachside-broker issuer set router-work
```

## Try a temporary grant

The `grant` commands require version 0.1.1 or later. With version 0.1.0, continue to the SDK example to issue and revoke grants automatically. [Give a sandbox a grant](#give-a-sandbox-a-grant).

In a private Bash or Zsh terminal with `BEACHSIDE_BROKER_URL` set, load the separate `BROKER_ISSUER_KEY` from `.env.deploy` or your secret manager.

```sh
printf 'Paste the broker issuer key and press Enter: '
read -rs BEACHSIDE_BROKER_ISSUER_KEY
printf '\n'
export BEACHSIDE_BROKER_ISSUER_KEY
beachside-broker grant issue router-work
```

The output includes the temporary `token`, the grant `id`, and the API base URL at `gatewayUrls["router-work"]`. The grant lasts five minutes by default.

To verify the grant, run this block in Bash or Zsh. Paste the gateway URL and token from the grant output when prompted. The request checks OpenRouter authentication without using model tokens and prints the HTTP status. [OpenRouter current key endpoint](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).

```sh
printf 'Paste the gateway URL and press Enter: '
read -r GATEWAY_URL
printf 'Paste the grant token and press Enter: '
read -rs GRANT_TOKEN
printf '\n'
printf 'Authorization: Bearer %s\n' "$GRANT_TOKEN" |
  curl --fail --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
    --header @- --url "${GATEWAY_URL%/}/key"
unset GATEWAY_URL GRANT_TOKEN
```

When you're done, copy the `id` from the grant output.

```sh
beachside-broker grant revoke YOUR_GRANT_ID
```

## Give a sandbox a grant

Install both packages in your sandbox application.

```sh
npm install beachside @beachside/credential-client
```

On the trusted orchestrator host, set `BEACHSIDE_BROKER_URL` to the deployed origin and `BEACHSIDE_BROKER_ISSUER_KEY` to the `BROKER_ISSUER_KEY` from `.env.deploy` or your secret manager. With a connected Beachside client and a sandbox image containing `printenv`, this example shows the OpenRouter URL available to sandbox commands. Their `OPENROUTER_API_KEY` variable contains the temporary grant.

```ts
import { createCredentialBroker } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: { apiKey: process.env.BEACHSIDE_BROKER_ISSUER_KEY! },
});

const result = await client.sandboxes.with(
  {
    network: "internet",
    credentials: broker.sandbox({
      endpoints: [
        {
          integration: "router-work",
          baseURLEnv: "OPENROUTER_BASE_URL",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      ttlSeconds: 900,
    }),
  },
  (box) => box.exec(["printenv", "OPENROUTER_BASE_URL"]),
);

console.log(result.stdoutText());
```

### Optional GitHub access

Create a GitHub integration using a token from a protected file, then add `github-work` to the issuance allowlist. Keep any IDs you already authorized when you call `issuer set`.

```sh
beachside-broker integration create github-work --provider github --secret-stdin < /secure/path/github-token
beachside-broker issuer show
beachside-broker issuer set router-work github-work
```

Add `github: "github-work"` alongside `endpoints` in `broker.sandbox()`. Use a sandbox image with Git and, if needed, GitHub CLI.

Git uses the broker for HTTPS URLs under `https://github.com/`. For `gh`, the environment sets `GH_HOST` to the broker hostname and `GH_ENTERPRISE_TOKEN` to the grant. An explicitly selected `github.com` GitHub CLI host takes precedence over `GH_HOST`. Use `gh api --hostname "$GH_HOST"` or `gh ... --repo "$GH_HOST/owner/repo"` to explicitly select the broker. The Worker accepts supported GitHub routes. The configured upstream GitHub credential determines repository access and write permissions. See the [broker route and permission reference](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#use-the-gateways).

For repositories owned by the GitHub account `gateway`, include the `.git` suffix in the HTTPS Git URL, for example `https://github.com/gateway/project.git`.

A broker can hold multiple GitHub integrations. Choose one per grant, such as `github: "github-tools"` for a sandbox working with the tools account. Git and GitHub CLI use that grant's selected GitHub credential on the shared broker host. A grant can include HTTPS endpoints alongside GitHub.

## GitHub Actions

Set `permissions: { id-token: write }` in the job and configure the workflow's exact identity, audience, and integration names in the broker's OIDC rules. The requested integrations must also be on the admin issuance allowlist. Request the token on the runner hosting Beachside.

```ts
import { createCredentialBroker, githubActionsOidc } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: githubActionsOidc({
    audience: "beachside-broker",
    env: process.env,
  }),
});
```

## Model clients and OpenCode

Each entry in `endpoints` names a configured HTTPS integration and the two environment variables your client uses. The broker URL for an integration is `https://<broker-host>/gateway/<integration-id>`. The API key variable contains the temporary grant, which the client sends as `Authorization: Bearer <grant>` or `x-api-key: <grant>`. The broker authenticates the grant, then sends the request to the configured upstream URL with the headers you set. The upstream keys stay in the broker.

The client appends its request path to the broker URL. Register an upstream base URL with the path prefix your client expects. For example, if an OpenAI-compatible client appends `/chat/completions`, register OpenRouter with `https://openrouter.ai/api/v1`. The Anthropic SDK appends `/v1/messages`, so its matching upstream base URL is `https://api.anthropic.com`. Pass the broker URL explicitly when a client does not read the environment variable.

Existing provider-specific integrations can still use the shorthand properties on `broker.sandbox()`.

| Integration property | Base URL variable     | Token variable       |
| -------------------- | --------------------- | -------------------- |
| `anthropic`          | `ANTHROPIC_BASE_URL`  | `ANTHROPIC_API_KEY`  |
| `openai`             | `OPENAI_BASE_URL`     | `OPENAI_API_KEY`     |
| `openrouter`         | `OPENROUTER_BASE_URL` | `OPENROUTER_API_KEY` |

With these shorthand properties, the OpenAI and OpenRouter URLs already include `/v1`. The Anthropic URL leaves it for the client to append.

For OpenCode V2, add the settings for the integrations your grant includes to the project's `opencode.json` or `.opencode/opencode.json`. OpenCode resolves these variable references from its command environment. The OpenRouter entry works with the generic integration shown above. For the Anthropic entry, use the `/v1` suffix shown here with the legacy Anthropic integration or with a generic integration whose upstream base is `https://api.anthropic.com`. [OpenCode configuration guide](https://opencode.ai/docs/config/), [OpenCode provider guide](https://opencode.ai/docs/providers/).

OpenCode v2.2.7 also accepts the same JSON through `OPENCODE_CONFIG_CONTENT` in the environment of the sandbox command that starts OpenCode. Keep the `{env:...}` references so OpenCode resolves the broker URL and temporary grant at startup. [OpenCode CLI environment variables](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/web/src/content/docs/cli.mdx#environment-variables).

![OpenCode v2 OpenRouter settings use {env:OPENROUTER_BASE_URL} for baseURL and {env:OPENROUTER_API_KEY} for apiKey. Pass the settings as inline JSON in OPENCODE_CONFIG_CONTENT.](/images/credential-broker/opencode-openrouter.png)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "anthropic": {
      "settings": {
        "baseURL": "{env:ANTHROPIC_BASE_URL}/v1",
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    },
    "openai": {
      "settings": {
        "baseURL": "{env:OPENAI_BASE_URL}",
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    },
    "openrouter": {
      "settings": {
        "baseURL": "{env:OPENROUTER_BASE_URL}",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      }
    }
  }
}
```

The [compiled OpenCode example](https://github.com/beachside-compute/beachside/blob/main/apps/docs/examples/credential-broker.ts) clones a project, writes the OpenRouter settings through the SDK, and starts OpenCode with the grant environment.

## Rotate or retire integrations

```sh
beachside-broker integration rotate router-work --credentials-stdin < /secure/path/replacement-headers.json
beachside-broker integration show router-work
beachside-broker integration disable router-work
```

Rotation increments the credential version. Grants keep their scope and newly authorized requests use the replacement, while in-flight requests may finish with the previous credential. Disabling an integration revokes grants that selected it, and enabling it again allows new grants subject to issuance permissions. Deleting an integration revokes its grants and clears its eligibility. Recreating the same ID requires explicit authorization again.

For an HTTPS integration, pipe a JSON object keyed by the secret header names into `integration rotate <id> --credentials-stdin`. Include only the secret values you intend to replace. To change an upstream base URL or its header definitions, create a new integration and authorize it for issuance.

The client sends each admin write once. If the call times out or you cancel it, the write may already have applied. Check the integration metadata and credential version with `integration show`, or check the issuance allowlist with `issuer show`, before retrying.

## Grant lifetime and cleanup

Beachside acquires the grant after it confirms sandbox creation and before setup runs. The grant goes into commands, processes, and terminals started through the creating connection. This includes verified handles reopened on that connection. Native SSH sessions and handles reopened through a new connection need independent configuration.

Command environment variables can accompany the grant. If a command supplies a different value for a broker-managed variable, Beachside rejects that command before execution. The same rule applies to the effective environment of setup and startup steps.

The default lifetime for a grant acquired by the SDK is 900 seconds. The broker accepts 1 to 3600 seconds. Sandbox renewal does not extend the grant. A tracked handle stops launching commands after grant expiry or revocation. The broker independently checks each request, including requests from a process that already has the grant.

Use `sandboxes.with()` for automatic cleanup or call `box.destroy()` yourself. Destruction attempts revocation independently of compute deletion. A `SandboxCredentialRevocationError` preserves a confirmed `destroyOutcome` or the original `destroyError` and its recovery reference. Setup failure revokes the grant, including when `onSetupFailure: "keep"` retains the sandbox. If an issuance response is lost before Beachside learns the grant identity, expiry bounds the grant.

If you stop waiting for revocation after compute destruction is confirmed, `WaitAbortedError.destroyOutcome` contains the confirmed compute result. The revocation attempt continues within its original budget. Use `submitDestroy()` to retain the operation handle and wait again.

Credentialed handles reject snapshots and forks. Use `sandboxes.create()` or `sandboxes.with()` to request a grant. Keep upstream keys in the broker, the admin key on the operator host, and the issuer key on the orchestrator. Sandbox code can read and use its own scoped grant until revocation or expiry.
