---
title: Credential broker
description: Give sandboxes short-lived, revocable access to GitHub and model APIs without putting the real keys in the sandbox.
---

A sandbox runs code you may not fully trust, and anything in its environment can leak. The credential broker keeps your real GitHub, OpenRouter, Anthropic or other API keys out of the sandbox. You run the broker in your own Cloudflare account. It stores the keys encrypted, and sandboxes get a **grant**: a token that only works through the broker, only for the integrations you picked, and only until it expires or you revoke it.

![A sandbox sends its temporary grant to your broker. The broker checks the grant, sends the real key to OpenRouter, and relays the response back to the sandbox.](/images/credential-broker/architecture.png)

The sandbox's client talks to the broker as if it were the API. A grant set up for OpenRouter gives the sandbox `OPENROUTER_BASE_URL` (the broker's gateway) and `OPENROUTER_API_KEY` (the grant). A GitHub grant configures `git` and `gh` so clones and API calls go through the broker.

## Should you use it?

| You want                                                      | Use                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| A quick experiment with your own key in a sandbox you control | `--env OPENROUTER_API_KEY` on `beachside create`, or `env` in the SDK |
| Agents or untrusted code that should never see the real key   | The credential broker                                                 |
| One key shared by many sandboxes, revocable per sandbox       | The credential broker                                                 |
| Always-on agents that need access for days                    | The credential broker, with 7-day grants you renew                    |

## Three keys, three places

Deploying the broker creates three keys. Each lives in one place.

- The **admin key** manages integrations and decides which ones may be granted. Keep it on your own machine or in your password manager.
- The **issuer key** only mints, renews and revokes grants. It goes wherever sandboxes are created: your laptop, a server or CI.
- The **encryption key** stays in the Worker and encrypts the upstream keys.

Sandboxes never get any of them. They only get grants.

## Grants

- A grant names one or more integrations, such as `github` and `openrouter`.
- It lasts from 1 second to 7 days. The CLI defaults to 1 hour, the SDK to 15 minutes.
- You can renew it to up to 7 days from now while it is active. An expired grant cannot be renewed.
- `beachside rm` and `box.destroy()` revoke it. Revoking stops the grant at once, while the upstream key keeps working for everything else.

## Next steps

- [Quickstart](/docs/credential-broker/quickstart/): deploy the broker, add OpenRouter and call it from a sandbox.
- [Use from the CLI](/docs/credential-broker/cli/) and [use from the SDK](/docs/credential-broker/sdk/).
- [GitHub access](/docs/credential-broker/github/), including GitHub Actions.
- [Model gateway recipes](/docs/credential-broker/model-gateways/) for Kilo, Cloudflare, Vercel, OpenAI, Anthropic and custom APIs.
- [Operate the broker](/docs/credential-broker/operate/): rotate keys, list grants and run it locally.
