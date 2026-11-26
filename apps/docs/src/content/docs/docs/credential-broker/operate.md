---
title: Operate the broker
description: Check, rotate, disable and upgrade a credential broker, see its grants, and run it locally.
---

Every command here runs through `beachside broker` with the admin key of a [connected broker](/docs/credential-broker/cli/#connect-a-broker). Without it, use [`beachside-broker`](/docs/credential-broker/quickstart/#use-it-from-somewhere-else) with the same commands and `BEACHSIDE_BROKER_ADMIN_KEY` set. Add `--json` for scripts. Exit codes match the rest of the CLI: 2 for a usage error, 3 not found, 5 a rejected key or permission, 6 when a write may have applied (check before retrying), 7 retryable.

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

The keys live only in the Worker and, for the admin and issuer keys, your password manager. `bun run deploy` never changes them. To replace the issuer or admin key, set a new value on the Worker, update it in your password manager, then on each machine that holds it as a value rather than a reference: `beachside broker add <name> --issuer-key ...` for the `beachside` CLI, or the `BEACHSIDE_BROKER_*` variables for `beachside-broker`.

```sh
bun run --cwd services/credential-broker wrangler secret put BROKER_ISSUER_KEY
```

The encryption key has no copy outside the Worker, so replacing it means re-entering every integration's upstream key. Follow the [key rotation steps](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#rotate-keys).

An `.env.deploy` from an older setup holds the keys as values. It keeps working, and `bun run broker` and `bun run deploy` in the broker checkout warn until you move the keys out. Every older deploy uploaded the file's keyring, so once your last deploy has succeeded the Worker holds the same keys and the file's copy can go. If you changed the keyring in the file without deploying it, deploy it with the older version of the broker first, because the file would then hold the only copy. Then save the admin and issuer keys in your password manager, replace them with references, and delete `BROKER_ENCRYPTION_KEYS` and `BROKER_ENCRYPTION_KEY_VERSION` from the file.

## Limits

The broker allows up to 1,000 active grants, 100 per issuer. Each grant has its own budget for each of its integrations, including streams: 800 requests a minute and 32 at once on GitHub, enough for large clones and fetches; 600 a minute and 32 at once on the Anthropic, OpenAI and OpenRouter gateways; and 300 a minute and 8 at once on custom `http` endpoints. A request over a limit gets HTTP `429`. To change one integration's limits, add `limits` to `BROKER_CONFIG` in `.env.deploy` and run `bun run deploy`. Set spend limits and scopes at the upstream provider as well. [Grant API limits](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#grant-api).

## Run a hosted broker

Single-tenant deployments keep their original URL, keys, config, and storage. A hosted deployment can serve multiple tenants from the same Worker, each with its own hostname, keys, storage, and limits. Configure a Cloudflare wildcard route and set `BROKER_TENANT_DOMAIN` to its suffix. Add any additional broker hostnames to `BROKER_HOST_ALIASES` so tenants cannot configure them as upstreams. [Hosted deployment setup](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#hosted-tenants)

Give the SaaS control plane a private Cloudflare Service Binding to `PlatformControl` for provisioning, listing, and inspecting tenants. Give the trusted operator Worker a separate binding to `PlatformOperator` for suspension and reactivation, role-key resets, deletion, and key rotation. Inspect recent sensitive operations with `PlatformOperator.auditLog()`.

Platform HTTP is off by default. If you need HTTPS platform access, enable `BROKER_PLATFORM_HTTP_ENABLED` and run `bun run deploy:setup --platform-key-only` in the broker checkout to create the separate routine and operator HTTP keys. Store each generated key in your secret manager. Private bindings work independently of the HTTP setting.

Point each client, Git remote, and gateway at its tenant's URL, such as `https://<id>.broker.example.com`. Sandbox tokens use the same format as the single-tenant broker. Use the tenant admin key with `PUT /v1/admin/config` to set per-grant limits and GitHub Actions policy. The GitHub Actions audience is `beachside-broker:<id>`. Hosted tenants use stored credentials and can send canary alerts to Slack and webhooks.

### Rotate a hosted deployment's root key

Add the new root version alongside the old one and make the new version active. Call `PlatformOperator.rewrap({ id })` for each active or suspended tenant. If platform HTTP is enabled, the equivalent is `POST /v1/platform/tenants/:id/rewrap` with the operator key. This preserves its data key and existing ciphertext. Retire the old root only after rewrap succeeds for all these tenants and the built-in broker's integrations and alert destinations have been rotated or recreated.

### Replace a tenant data key

Use `PlatformOperator.rotateDataKey({ id })` to give the tenant a new data key and re-encrypt stored credentials and alert configuration. Retry an interrupted operation to resume. Rotate upstream credentials at their providers if those credentials may already have been exposed.

## Trust a token issuer

A deployment can accept short-lived ES256 tokens from a control plane. In `BROKER_CONFIG.trustedIssuers`, configure the exact issuer, HTTPS JWKS URL, expected audience, and permitted roles. Use the self-hosted broker origin as the audience for a pinned issuer, or `https://<BROKER_TENANT_DOMAIN>` for an unpinned hosted issuer. The default role is `issuer`. Grant `admin` only when the control plane needs to manage the target broker.

A self-hosted broker pins the entry to one org ID using `tenant`. Tokens for that org act on the built-in broker at its existing URL, without a platform key. A hosted broker can omit the pin so tokens can act on hosted tenants. Send each token to the tenant subdomain named by its signed `tenant` claim. Give each agent a stable, distinct `sub` so it can manage its own grants. [Trusted issuer configuration](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#trusted-token-issuers)

## Run it locally

To try changes without deploying, run the Worker with Wrangler on your machine. [Local setup](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#run-wrangler-locally). The CLI accepts plain HTTP for `localhost`, so connect it with the fixture keys you generated.

```sh
beachside broker add local --url http://localhost:8787 --issuer-key env:LOCAL_ISSUER_KEY --admin-key env:LOCAL_ADMIN_KEY
beachside broker status --broker local
```

A sandbox can't reach your `localhost`, so test grants inside sandboxes against a deployed broker.

## Upgrade

Pull the broker repository and run `bun run deploy` again. Grants and integrations are kept, and the database migrates on first use. [Deployment runbook](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#deploy).
