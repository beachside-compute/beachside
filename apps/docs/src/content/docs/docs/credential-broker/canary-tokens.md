---
title: Canary tokens
description: Plant decoy grants and get a Slack message or webhook alert the moment someone tries to use one.
---

A canary is a decoy grant. It looks exactly like a real one, but nothing legitimate ever uses it. Plant it where only an intruder would find it, such as a decoy `.env` in a repository, a secret on an unused CI workflow, or a sandbox image. When anyone presents it to the broker, the broker refuses the request as it would an expired grant, records who tried, and alerts your destinations.

A canary catches someone who stole a broker grant or a sandbox's environment and tried to use it. A provider key used directly at its provider never reaches the broker, so it can't catch that. Sandboxes only ever hold grants, which is the risk the broker is placed to see.

Every command here needs the admin key of a [connected broker](/docs/credential-broker/cli/#connect-a-broker).

## Add a destination

Alerts go to a Slack channel or to any HTTPS webhook. Every destination receives every canary's alerts.

```sh
beachside broker alert add slack ops-chat --to-stdin < /secure/path/slack-webhook-url
beachside broker alert add webhook pager --to-stdin < /secure/path/alert-url
beachside broker alert test pager
beachside broker alert list
```

- **Slack** takes an [incoming webhook](https://api.slack.com/messaging/webhooks) URL and posts a readable message: the canary, the caller's IP and network, the request, and the trip count.
- **Webhook** posts a flat JSON object of strings to any HTTPS URL. It's signed per [Standard Webhooks](https://www.standardwebhooks.com/), and the signing secret is printed once, when you add the destination. Add headers with `--header Name=value`, for a receiver that authenticates by header.

`--to` and `--header` values can be `op://`, `bws://` or `pass://` references. The broker seals the URL, headers and signing secret with its encryption key, and listings show only the host and header names.

### incident.io and PagerDuty

Both take the generic webhook:

- **incident.io:** create an HTTP alert source with a custom payload. Set its deduplication key path to `$.dedup_key` and map `title` and `status` in the transform. Then add its events URL with the source's token:

  ```sh
  beachside broker alert add webhook incident \
    --to https://api.incident.io/v2/alert_events/http/<source-id> \
    --header "Authorization=op://Ops/incident-io/canary-source"
  ```

- **PagerDuty:** add a Custom Event Transformer integration to a service, map `title`, `severity` and `dedup_key` in its JavaScript, and add the integration URL as a webhook destination.

Each canary keeps one `dedup_key`, so repeated trips update one open alert instead of paging again.

## Plant a canary

```sh
beachside broker canary issue openrouter github --label "decoy .env on build-box" --env > decoy.env
```

`--env` prints the variables a [sandbox grant](/docs/credential-broker/sdk/) would set, such as `OPENROUTER_BASE_URL` and `OPENROUTER_API_KEY`, or git and `gh` settings for a GitHub integration. Without it, the command prints the token and base URLs. The label is what alerts name, so make it say where you planted the canary.

Canaries don't expire. They don't appear in `grant list`, and an issuer key can't see them.

## When a canary trips

The broker answers with the same `401` an unknown grant gets. It never proxies the request or touches an upstream key. Presenting the canary as the admin or issuer key, or renewing or revoking its ID, trips it too.

```sh
beachside broker canary list               # label, integrations, trips, last trip
beachside broker canary show <canary-id>   # the last 100 uses
beachside broker canary revoke <canary-id>
```

Each use records the route, method and path (never the query string), and what Cloudflare saw of the caller: IP address, country, network and ASN, data center and user agent.

**Limits.**

- Each destination gets at most one alert an hour. Trips inside that hour are counted in the next alert as `trips_since_last_alert`, with every tripped canary listed in `canaries_tripped`.
- Delivery is a single attempt with no retries. `alert list` shows each destination's last delivery, and `alert test` sends a test event at any time.

The webhook body looks like this:

```json
{
  "type": "canary.triggered",
  "dedup_key": "beachside-canary-<canary-id>",
  "status": "firing",
  "severity": "critical",
  "title": "Canary \"decoy .env on build-box\" used from 203.0.113.7 (DigitalOcean, NL) via gateway",
  "canary_label": "decoy .env on build-box",
  "trips_total": "3",
  "trips_since_last_alert": "2",
  "request_route": "gateway",
  "request_integration": "openrouter",
  "request_path": "/gateway/openrouter/v1/chat/completions",
  "request_ip": "203.0.113.7",
  "request_country": "NL",
  "request_as_org": "DigitalOcean",
  "request_user_agent": "OpenAI/Python 1.x"
}
```

The [operator runbook](https://github.com/beachside-compute/credential-broker/blob/main/services/credential-broker/README.md#canary-tokens) lists every field.
