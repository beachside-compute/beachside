---
title: Operate the broker
description: Check, rotate, disable and upgrade a credential broker, see its grants, and run it locally.
---

Every command here runs through `beachside broker` with the admin key of a [connected broker](/docs/credential-broker/cli/#connect-a-broker). Add `--json` for scripts. Exit codes match the rest of the CLI: 2 for a usage error, 3 not found, 5 a rejected key or permission, 6 when a write may have applied (check before retrying), 7 retryable.

## Check the broker

```sh
beachside broker status          # the key's role, the grant limit, and counts with the admin key
beachside broker config show     # the GitHub Actions trust policy the deployment loaded
beachside broker integration list
beachside broker issuer show     # integrations the issuer may grant
```

`integration list` marks an integration that the issuer can't grant yet. Allow it with `issuer allow <id>`, or stop new grants with `issuer deny <id>`. Existing grants keep working until they expire.

## See and end grants

```sh
beachside broker grant list            # grants made with this machine's issuer key
beachside broker grant list --all      # every grant, with the issuing role, using the admin key
beachside broker grant revoke <grant-id>
```

The listing shows each grant's label (sandbox grants are labelled `beachside <name>`), integrations, expiry, request count and last use. It never shows tokens.

## Rotate an upstream key

```sh
beachside broker integration rotate github --secret-stdin < /secure/path/new-github-token
node -e 'console.log(JSON.stringify({ Authorization: process.env.NEW_OPENROUTER_API_KEY }))' |
  beachside broker integration rotate openrouter --credentials-stdin
beachside broker integration show openrouter
```

Existing grants keep their scope and use the new key from their next request. Requests already in flight may finish with the old one. For an HTTPS endpoint integration, pass only the secret headers you're replacing. To change its URL or headers, create a new integration.

## Disable or delete an integration

```sh
beachside broker integration disable openrouter
beachside broker integration enable openrouter
beachside broker integration delete openrouter
```

Disabling revokes the integration's grants. Deleting also removes it from the issuer allowlist, so recreating the same ID needs `issuer allow` again. Revoking a grant or deleting an integration leaves the upstream key itself active at GitHub or the provider.

## Rotate the broker's own keys

The admin, issuer and encryption keys live in the deployment's `.env.deploy`. To replace the issuer or admin key, change it there and run `bun run deploy`, then update each machine with `beachside broker add <name> --issuer-key ...`. Rotating the encryption key takes two deploys and a rotation of every integration. Follow the [encryption key steps](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#rotate-an-encryption-key) exactly, because losing an old key makes the integrations encrypted with it unreadable.

## Limits

The broker allows up to 1,000 active grants, 100 per issuer. Each grant may make 120 requests a minute and 8 at once, including streams. A request over a limit gets HTTP `429`. Set spend limits and scopes at the upstream provider as well. [Grant API limits](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#grant-api).

## Run it locally

To try changes without deploying, run the Worker with Wrangler on your machine. [Local setup](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#run-wrangler-locally). The CLI accepts plain HTTP for `localhost`, so connect it with the fixture keys you generated.

```sh
beachside broker add local --url http://localhost:8787 --issuer-key env:LOCAL_ISSUER_KEY --admin-key env:LOCAL_ADMIN_KEY
beachside broker status --broker local
```

A sandbox can't reach your `localhost`, so test grants inside sandboxes against a deployed broker.

## Upgrade

Pull the broker repository and run `bun run deploy` again. Grants and integrations are kept, and the database migrates on first use. [Deployment runbook](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#deploy).
