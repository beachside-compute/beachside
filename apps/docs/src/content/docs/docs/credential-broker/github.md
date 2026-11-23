---
title: GitHub access
description: Let sandboxes clone, push and call the GitHub API through the credential broker, including from GitHub Actions.
---

A GitHub integration holds a GitHub token in the broker. Sandboxes with a grant for it use `git` and `gh` as usual, while the broker adds the real token to each request.

The commands here use the [`beachside` CLI](/docs/credential-broker/cli/) connected to your broker. Without it, run the same `broker` commands as `beachside-broker` or `bun run broker`. See [run the same commands anywhere](/docs/credential-broker/quickstart/#4-run-the-same-commands-anywhere).

## Add a GitHub integration

Use a token with only the repositories and permissions the sandbox should have, such as a fine-grained personal access token. Read it from a protected file so it never appears in your shell history.

```sh
beachside broker integration create github --provider github --secret-stdin --allow-issue < /secure/path/github-token
```

`--allow-issue` lets the issuer grant it right away. A broker can hold several GitHub integrations, such as `github` and `github-tools`, but each grant uses one.

## Use it in a sandbox

```sh
beachside create --name agent --network internet --grant github
```

From the SDK, pass `broker.sandbox({ integrations: ["github"] })`. The sandbox image needs Git, and GitHub CLI if you use `gh`.

- **Git** sends HTTPS URLs under `https://github.com/` through the broker. `git clone https://github.com/owner/repo` works unchanged.
- **GitHub CLI** gets `GH_HOST` set to the broker host and `GH_ENTERPRISE_TOKEN` set to the grant. A `gh` host you selected explicitly, such as `github.com`, takes precedence over `GH_HOST`, so use `gh api --hostname "$GH_HOST"` or `--repo "$GH_HOST/owner/repo"` when in doubt.
- The broker forwards the GitHub routes that Git and common `gh` commands use. The upstream token decides which repositories the sandbox can read or write. [Supported routes](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#use-the-gateways).

For repositories owned by the GitHub account named `gateway`, include the `.git` suffix, as in `https://github.com/gateway/project.git`, because `/gateway/` paths belong to the broker's model gateways.

## GitHub Actions

A workflow can issue grants with its own OIDC token instead of an issuer key, so there is no long-lived secret in the repository. The broker only accepts workflows you list in its deployment configuration, and only for the integrations listed there.

1. Add the workflow to `BROKER_CONFIG` in the broker's `.env.deploy` and run `bun run deploy` again. Changes take effect only after a deploy. [Workflow policy reference](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#authenticate-grant-issuance).

   ```json
   {
     "githubActions": {
       "audience": "https://broker.example.com/github-actions",
       "workflows": [
         {
           "repositoryId": "123456789",
           "repositoryOwnerId": "23456789",
           "repository": "example-org/review-service",
           "ref": "refs/heads/main",
           "workflowRef": "example-org/review-service/.github/workflows/review.yml@refs/heads/main",
           "event": "push",
           "integrations": ["github", "openrouter"]
         }
       ]
     }
   }
   ```

2. Allow the same integrations for issuance, if they aren't already: `beachside broker issuer allow github openrouter`.
3. `beachside broker config show` confirms what the deployed broker trusts.
4. Give the job `permissions: { id-token: write }`, install the client with `npm install @beachside/credential-client`, and request grants on the runner:

   ```ts
   import { createCredentialBroker, githubActionsOidc } from "@beachside/credential-client";

   const broker = createCredentialBroker({
     url: process.env.BEACHSIDE_BROKER_URL!,
     auth: githubActionsOidc({
       audience: "https://broker.example.com/github-actions",
       env: process.env,
     }),
   });
   ```

Keep pull-request code out of the job that requests grants, and run it inside the sandbox instead. That matters most for `pull_request_target` and `workflow_run` events.
