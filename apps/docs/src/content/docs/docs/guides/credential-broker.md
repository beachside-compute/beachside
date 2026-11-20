---
title: Credential broker
description: Give sandbox commands short-lived GitHub and model access through a self-hosted credential broker.
---

The Beachside credential broker stores upstream keys and issues short-lived grants for GitHub and HTTPS APIs. A sandbox receives a temporary grant and the broker URL for its integration.

## Deploy the broker

On your operator machine, use Bun 1.4.4, Node.js 22 or later, and a Cloudflare account that can deploy Workers and SQLite Durable Objects.

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

From the broker checkout, replace the example URL with the deployed origin and open the wizard.

```sh
bun run broker --url https://your-broker.example.com integration setup
```

Choose OpenRouter with the arrow keys, enter `router-work` as the integration ID, and paste the OpenRouter key in the masked prompt. Pressing Enter at the ID prompt uses `openrouter`. If you use that default, substitute it for `router-work` in the commands and SDK examples below. The same wizard supports other gateways and custom HTTPS endpoints. [Model gateway recipes](/docs/guides/model-gateways/).

Add `BEACHSIDE_BROKER_URL=https://your-broker.example.com` to `.env.deploy` with your actual origin so the remaining commands can omit `--url`. Integration and allowlist commands use the admin key from that file. Grant commands use the separate issuer key.

Check which integrations the issuer can use.

```sh
bun run broker issuer show
```

If the list is empty, allow grants for `router-work`. If the list already has IDs, pass them alongside `router-work`. The command replaces the entire list.

```sh
bun run broker issuer set router-work
```

## Try a temporary grant

Run this in a private terminal. The output includes the temporary `token`, the grant `id`, and a ready-to-use API base URL at `gatewayUrls["router-work"]`. The grant lasts five minutes by default.

```sh
bun run broker grant issue router-work
```

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
bun run broker grant revoke YOUR_GRANT_ID
```

## Give a sandbox a grant

Install both packages in your sandbox application.

```sh
npm install beachside @beachside/credential-client
```

![The sandbox sends a temporary grant to the Cloudflare broker. The broker validates it, calls OpenRouter with the stored upstream API key, and forwards the response to the sandbox.](/images/credential-broker/architecture.png)

On the trusted orchestrator host, set `BEACHSIDE_BROKER_URL` to the deployed origin and `BEACHSIDE_BROKER_ISSUER_KEY` to the `BROKER_ISSUER_KEY` from `.env.deploy` or your secret manager. Beachside supplies the temporary grant to sandbox commands. For a model-only setup, use just the endpoint mapping. [Model endpoint example](/docs/guides/model-gateways/#select-the-endpoint-in-a-sandbox).

The example below also uses GitHub and assumes a Linux sandbox image with Git and GitHub CLI. To follow it, add a GitHub integration from the broker checkout and authorize both IDs. Include any other IDs you want to keep.

```sh
printf '%s' "$WORK_GITHUB_TOKEN" |
  bun run broker integration create github-work --provider github --secret-stdin
bun run broker issuer set router-work github-work
```

```ts
import { createCredentialBroker } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: { apiKey: process.env.BEACHSIDE_BROKER_ISSUER_KEY! },
});

await client.sandboxes.with(
  {
    network: "internet",
    credentials: broker.sandbox({
      github: "github-work",
      endpoints: [
        {
          integration: "router-work",
          baseURLEnv: "OPENROUTER_BASE_URL",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      ttlSeconds: 900,
    }),
    setup: [["git", "clone", "https://github.com/acme/project.git", "/tmp/project"]],
  },
  async (box) => {
    await box.exec(["gh", "api", "repos/acme/project", "--jq", ".full_name"]);
  },
);
```

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
bun run broker integration rotate router-work --credentials-stdin < /secure/path/replacement-headers.json
bun run broker integration show router-work
bun run broker integration disable router-work
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
