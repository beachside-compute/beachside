---
title: Canary tokens
description: Plant decoy grants and get a Slack message, email or webhook alert the moment someone tries to use one.
---

A canary is a decoy grant. It looks exactly like a real one, but nothing legitimate ever uses it. Plant it where only an intruder would find it, such as a decoy `.env` in a repository, a secret on an unused CI workflow, or a sandbox image. When anyone presents it to the broker, the broker refuses the request as it would an expired grant, records who tried, and alerts your destinations.

A canary catches someone who stole a broker grant or a sandbox's environment and tried to use it. A provider key used directly at its provider never reaches the broker, so it can't catch that. Sandboxes only ever hold grants, which is the risk the broker is placed to see.

Every command here needs the admin key of a [connected broker](/docs/credential-broker/cli/#connect-a-broker).

## Add a destination

Alerts go to a Slack channel, an email address or any HTTPS webhook. Every destination receives every canary's alerts.

```sh
beachside broker alert add slack ops-chat --to-stdin < /secure/path/slack-webhook-url
beachside broker alert add webhook pager --to-stdin < /secure/path/alert-url
beachside broker alert add email inbox --to oncall@example.com
beachside broker alert test pager
beachside broker alert list
```

- **Slack** takes an [incoming webhook](https://api.slack.com/messaging/webhooks) URL and posts a readable message: the canary, the caller's IP and network, the request, and the trip count.
- **Webhook** posts a flat JSON object of strings to any HTTPS URL. It's signed per [Standard Webhooks](https://www.standardwebhooks.com/), and the signing secret is printed once, when you add the destination. Add headers with `--header Name=value`, for a receiver that authenticates by header.
- **Email** sends a plain-text message to one address through Cloudflare Email Service. It needs one-time setup on the broker; see [Email alerts](#email-alerts).

`--to` and `--header` values can be `op://`, `bws://` or `pass://` references. The broker seals each destination, including an email address, with its encryption key. Listings show only the host and header names, or the address for an email destination.

### Email alerts

Email goes out through [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/), which needs the Workers Paid plan and a domain on Cloudflare DNS. If your domain isn't on Cloudflare, use Slack or a webhook.

1. In the Cloudflare dashboard, go to **Compute** > **Email Service** > **Email Sending**, select **Onboard Domain**, and pick a subdomain such as `alerts.example.com`. Cloudflare adds the DNS records itself, usually within minutes. A subdomain keeps alert mail apart from your main domain's mail.
2. In the broker checkout, add `BROKER_EMAIL_FROM=canary@alerts.example.com` to `.env.deploy` and run `bun run deploy`.
3. Add the destination and send a test:

   ```sh
   beachside broker alert add email inbox --to oncall@example.com
   beachside broker alert test inbox
   ```

The subject is the alert's title, and the body lists every field of the event.

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
