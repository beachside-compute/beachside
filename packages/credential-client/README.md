# @beachside/credential-client

Operator and orchestrator tools for the self-hosted [Beachside credential broker](https://github.com/beachside-compute/beachside/tree/main/services/credential-broker).

```sh
npm install beachside @beachside/credential-client
```

## Manage integrations

On the operator host, set `BEACHSIDE_BROKER_URL` to the Worker HTTPS origin and `BEACHSIDE_BROKER_ADMIN_KEY` to the deployment's admin key.

```sh
printf '%s' "$UPSTREAM_GITHUB_TOKEN" |
  npx beachside-broker integration create github-work --provider github --secret-stdin
npx beachside-broker issuer set github-work
npx beachside-broker integration list
```

Use `beachside-broker --help` for commands to show, rotate, disable, enable, and delete integrations. A stored credential can be supplied on stdin, or by referencing an existing Worker secret with `--worker-secret CREDENTIAL_NAME`. Output is JSON metadata. The issuer allowlist starts empty and must be explicitly set. Changing the allowlist replaces the whole set of eligible integrations.

Use `createCredentialBrokerAdmin({ url, apiKey })` for the same operations in code. Keep the admin key on the operator host and use the separate issuer key or GitHub Actions OIDC for grants.

The client sends each admin write once. A write may already have applied when the call times out or is cancelled. Inspect the integration metadata and credential version or the issuance allowlist before retrying.

## Use a grant from Beachside

```ts
import { createCredentialBroker } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: { apiKey: process.env.BEACHSIDE_BROKER_ISSUER_KEY! },
});

await client.sandboxes.with(
  {
    network: "internet",
    credentials: broker.sandbox({ github: "github-work" }),
  },
  async (box) => {
    await box.exec(["git", "clone", "https://github.com/acme/project.git"]);
  },
);
```

The names passed to `broker.sandbox()` select eligible runtime integrations. Supported properties are `github`, `anthropic`, `openai`, and `openrouter`. Choose at most one GitHub integration per grant. The SDK supplies the grant to commands started through the creating connection and attempts revocation when the sandbox is destroyed. Grants default to 900 seconds and support 1 to 3600 seconds.

Use `githubActionsOidc({ audience, env: process.env })` as `auth` on a trusted GitHub Actions runner with `id-token: write`. The client obtains a fresh identity token for each grant-management request.

Use `broker.issue({ integrations, ttlSeconds })` and `broker.revoke(grant.id)` for standalone grant control. Calling `issue()` exposes a bearer token to the host application. Grant tokens authorize access until revoked or expired.

See the [credential broker guide](https://beachside.run/docs/guides/credential-broker/) for deployment, GitHub CLI, model SDKs, OpenCode, and grant cleanup.
