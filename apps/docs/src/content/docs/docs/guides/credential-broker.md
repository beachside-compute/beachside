---
title: Credential broker
description: Give sandbox commands short-lived GitHub and model access through a self-hosted credential broker.
---

The [Beachside credential broker](https://github.com/beachside-compute/beachside/tree/main/services/credential-broker) holds upstream GitHub and model credentials. Set up the Worker and its integrations first, then install the client alongside Beachside.

```sh
npm install beachside @beachside/credential-client
```

Create the broker client on the trusted host. This example assumes the connected Beachside client has a Linux image with Git and GitHub CLI, and that the Worker has integrations named `github-work` and `router-work`.

```ts
import { createCredentialBroker } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: { apiKey: process.env.BEACHSIDE_BROKER_KEY! },
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

## GitHub Actions

Set `permissions: { id-token: write }` in the job and configure the Workflow's exact identity and audience in the broker's OIDC rules. Request the token on the runner hosting Beachside.

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

## Grant lifetime and cleanup

Beachside acquires the grant after it confirms sandbox creation and before setup runs. The grant goes into commands, processes, and terminals started through the creating connection. This includes verified handles reopened on that connection. Native SSH sessions and handles reopened through a new connection need independent configuration.

The default grant lifetime is 900 seconds. The broker accepts 1 to 3600 seconds. Sandbox renewal does not extend the grant. A tracked handle stops launching commands after grant expiry or revocation. The broker independently checks each request, including requests from a process that already has the grant.

Use `sandboxes.with()` for automatic cleanup or call `box.destroy()` yourself. Destruction attempts revocation independently of compute deletion. A `SandboxCredentialRevocationError` preserves a confirmed `destroyOutcome` or the original `destroyError` and its recovery reference. Setup failure revokes the grant, including when `onSetupFailure: "keep"` retains the sandbox. If an issuance response is lost before Beachside learns the grant identity, expiry bounds the grant.

Credentialed handles reject snapshots and forks. Restore and advanced `submitCreate()` do not accept `credentials`. Keep upstream keys in the Worker's secret store and the broker management credential on the trusted host. Sandbox code can read and use its own scoped grant until revocation or expiry.
