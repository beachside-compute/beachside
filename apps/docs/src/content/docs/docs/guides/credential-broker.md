---
title: Credential broker
description: Give sandbox commands short-lived GitHub and model access through a self-hosted credential broker.
---

The Beachside credential broker stores upstream GitHub and model credentials and issues short-lived grants for sandbox workloads. After deployment, use the admin client or CLI to manage runtime integrations. Each integration selects a fixed provider and its upstream credential.

## Deploy the broker

Configure three Worker secrets. `BROKER_ADMIN_KEY` authorizes integration and issuance settings. `BROKER_ISSUER_KEY` authorizes grant requests. `BROKER_ENCRYPTION_KEYS` maps version labels to base64url-encoded 32-byte encryption keys. The `BROKER_ENCRYPTION_KEY_VERSION` setting selects the active version for writes. Keep prior encryption versions configured until their stored credentials have been rotated. [Worker deployment and bootstrap](https://github.com/beachside-compute/beachside/tree/main/services/credential-broker).

The new deployment starts with no integrations or issuer permissions. Add integrations and authorize issuance before launching a credentialed sandbox.

## Set up runtime integrations

```sh
npm install beachside @beachside/credential-client
```

Set `BEACHSIDE_BROKER_URL` to the Worker HTTPS origin and `BEACHSIDE_BROKER_ADMIN_KEY` to its `BROKER_ADMIN_KEY` on the operator host. The installed `beachside-broker` CLI reads upstream values from stdin and sends them over HTTPS for encrypted storage. Its output contains integration metadata.

```sh
printf '%s' "$WORK_GITHUB_TOKEN" |
  npx beachside-broker integration create github-work --provider github --secret-stdin
printf '%s' "$TOOLS_GITHUB_TOKEN" |
  npx beachside-broker integration create github-tools --provider github --secret-stdin
printf '%s' "$ANTHROPIC_KEY" |
  npx beachside-broker integration create claude-work --provider anthropic --secret-stdin
printf '%s' "$OPENROUTER_KEY" |
  npx beachside-broker integration create router-work --provider openrouter --secret-stdin

npx beachside-broker issuer set github-work github-tools claude-work router-work
npx beachside-broker integration list
```

The issuance allowlist starts empty. Adding an integration leaves issuance eligibility unchanged. `issuer set` replaces the whole allowlist, and `issuer set` with no IDs clears it. A GitHub Actions job also needs permission for the integration in its deployed workflow policy.

For deployments holding the upstream value in a Worker secret binding, declare the binding name in `BROKER_CONFIG.workerSecretBindings` and pass `--worker-secret CREDENTIAL_EXAMPLE` in place of `--secret-stdin` to create or rotate a reference. The admin API accepts the same source choices through `createCredentialBrokerAdmin()` from `@beachside/credential-client`.

## Give a sandbox a grant

On the trusted orchestrator host, use `BROKER_ISSUER_KEY` as the issuer API key. This example assumes the connected Beachside client has a Linux image with Git and GitHub CLI.

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
      openrouter: "router-work",
      ttlSeconds: 900,
    }),
    setup: [["git", "clone", "https://github.com/acme/project.git", "/tmp/project"]],
  },
  async (box) => {
    await box.exec(["gh", "api", "repos/acme/project", "--jq", ".full_name"]);
  },
);
```

Git uses the broker for HTTPS URLs under `https://github.com/`. For `gh`, the environment sets `GH_HOST` to the broker hostname and `GH_ENTERPRISE_TOKEN` to the grant. An explicitly selected `github.com` GitHub CLI host takes precedence over `GH_HOST`. Use `gh api --hostname "$GH_HOST"` or `gh ... --repo "$GH_HOST/owner/repo"` to explicitly select the broker. The Worker accepts supported GitHub routes. The configured upstream GitHub credential determines repository access and write permissions. See the [broker route and permission reference](https://github.com/beachside-compute/beachside/tree/main/services/credential-broker).

A broker can hold multiple GitHub integrations. Choose one per grant, such as `github: "github-tools"` for a sandbox working with the tools account. Git and GitHub CLI use that grant's selected GitHub credential on the shared broker host. A grant can include model integrations alongside GitHub.

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

Each property of `broker.sandbox()` names an integration configured on the Worker.

| Integration property | Base URL variable     | Token variable       |
| -------------------- | --------------------- | -------------------- |
| `anthropic`          | `ANTHROPIC_BASE_URL`  | `ANTHROPIC_API_KEY`  |
| `openai`             | `OPENAI_BASE_URL`     | `OPENAI_API_KEY`     |
| `openrouter`         | `OPENROUTER_BASE_URL` | `OPENROUTER_API_KEY` |

The Anthropic SDK adds `/v1` to its base URL. OpenAI and OpenRouter URLs already include `/v1`. Pass the base URL to a client explicitly when it does not read the environment variable.

For OpenCode V2, add these settings for the providers your grant includes in the project's `opencode.json` or `.opencode/opencode.json`. The file contains variable references. OpenCode resolves them from its command environment. [OpenCode configuration guide](https://opencode.ai/docs/config/), [OpenCode provider guide](https://opencode.ai/docs/providers/).

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
printf '%s' "$REPLACEMENT_GITHUB_TOKEN" |
  npx beachside-broker integration rotate github-work --secret-stdin
npx beachside-broker integration show github-work
npx beachside-broker integration disable github-tools
```

Rotation increments the credential version. Grants keep their scope and newly authorized requests use the replacement, while in-flight requests may finish with the previous credential. Disabling an integration revokes grants that selected it, and enabling it again allows new grants subject to issuance permissions. Deleting an integration revokes its grants and clears its eligibility. Recreating the same ID requires explicit authorization again.

The client sends each admin write once. If the call times out or you cancel it, the write may already have applied. Check the integration metadata and credential version with `integration show`, or check the issuance allowlist with `issuer show`, before retrying.

## Grant lifetime and cleanup

Beachside acquires the grant after it confirms sandbox creation and before setup runs. The grant goes into commands, processes, and terminals started through the creating connection. This includes verified handles reopened on that connection. Native SSH sessions and handles reopened through a new connection need independent configuration.

Command environment variables can accompany the grant. If a command supplies a different value for a broker-managed variable, Beachside rejects that command before execution. The same rule applies to the effective environment of setup and startup steps.

The default grant lifetime is 900 seconds. The broker accepts 1 to 3600 seconds. Sandbox renewal does not extend the grant. A tracked handle stops launching commands after grant expiry or revocation. The broker independently checks each request, including requests from a process that already has the grant.

Use `sandboxes.with()` for automatic cleanup or call `box.destroy()` yourself. Destruction attempts revocation independently of compute deletion. A `SandboxCredentialRevocationError` preserves a confirmed `destroyOutcome` or the original `destroyError` and its recovery reference. Setup failure revokes the grant, including when `onSetupFailure: "keep"` retains the sandbox. If an issuance response is lost before Beachside learns the grant identity, expiry bounds the grant.

If you stop waiting for revocation after compute destruction is confirmed, `WaitAbortedError.destroyOutcome` contains the confirmed compute result. The revocation attempt continues within its original budget. Use `submitDestroy()` to retain the operation handle and wait again.

Credentialed handles reject snapshots and forks. Use `sandboxes.create()` or `sandboxes.with()` to request a grant. Keep upstream keys in the broker, the admin key on the operator host, and the issuer key on the orchestrator. Sandbox code can read and use its own scoped grant until revocation or expiry.
