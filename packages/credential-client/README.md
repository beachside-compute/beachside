# @beachside/credential-client

Trusted-host client for the self-hosted [Beachside credential broker](https://github.com/beachside-compute/beachside/tree/main/services/credential-broker).

```sh
npm install beachside @beachside/credential-client
```

```ts
import { createCredentialBroker } from "@beachside/credential-client";

const broker = createCredentialBroker({
  url: process.env.BEACHSIDE_BROKER_URL!,
  auth: { apiKey: process.env.BEACHSIDE_BROKER_KEY! },
});

await client.sandboxes.with(
  {
    network: "internet",
    credentials: broker.sandbox({ github: "github-work", openai: "openai-work" }),
  },
  async (box) => {
    await box.exec(["git", "clone", "https://github.com/acme/project.git"]);
  },
);
```

The names passed to `broker.sandbox()` select configured Worker integrations. The SDK supplies the resulting short-lived grant to commands started through the creating connection and attempts revocation when the sandbox is destroyed. Supported integration properties are `github`, `anthropic`, `openai`, and `openrouter`. Grants default to 900 seconds and support 1 to 3600 seconds.

Use `githubActionsOidc({ audience, env: process.env })` as `auth` on a trusted GitHub Actions runner with `id-token: write`. The client obtains a fresh identity token for each management request.

Use `broker.issue({ integrations, ttlSeconds })` and `broker.revoke(grant.id)` for standalone control. Calling `issue()` exposes a bearer token to the host application. Grant tokens authorize access until revoked or expired.

See the [credential broker guide](https://beachside.run/docs/guides/credential-broker/) for GitHub CLI, model SDKs, OpenCode, and cleanup behavior.
