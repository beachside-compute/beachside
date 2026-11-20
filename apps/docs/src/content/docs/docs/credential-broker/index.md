---
title: Credential broker
description: Give sandboxes short-lived, revocable access to GitHub and model APIs without handing your real keys to the sandbox or its provider.
---

Putting an API key in a sandbox hands it to two parties: the code running inside, which you may not fully trust, and the sandbox provider, which now holds your key in its environment, logs or snapshots. The credential broker avoids both. You run the broker in your own Cloudflare account and it stores your GitHub, OpenRouter, Anthropic or other API keys encrypted. Your real keys never reach the sandbox or the provider. Sandboxes get a **grant** instead: a token that only works through your broker, only for the integrations you picked, and only until it expires or you revoke it.

![A sandbox sends its temporary grant to your broker. The broker checks the grant, sends the real key to OpenRouter, and relays the response back to the sandbox.](/images/credential-broker/architecture.png)

The sandbox's client talks to the broker as if it were the API. A grant set up for OpenRouter gives the sandbox `OPENROUTER_BASE_URL` (the broker's gateway) and `OPENROUTER_API_KEY` (the grant). A GitHub grant configures `git` and `gh` so clones and API calls go through the broker.

## Should you use it?

| You want                                                          | Use                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| A quick experiment with your own key in a sandbox you control     | `--env OPENROUTER_API_KEY` on `beachside create`, or `env` in the SDK |
| Real keys that neither the sandbox code nor the provider ever see | The credential broker                                                 |
| One key shared by many sandboxes, revocable per sandbox           | The credential broker                                                 |
| Always-on agents that need access for days                        | The credential broker, with 7-day grants you renew                    |

## Three keys, three places

Deploying the broker creates three keys. Each lives in one place.

- The **admin key** manages integrations and decides which ones may be granted. Keep it on your own machine or in your password manager.
- The **issuer key** only mints, renews and revokes grants. It goes wherever sandboxes are created: your laptop, a server or CI.
- The **encryption key** stays in the Worker and encrypts the upstream keys.

Sandboxes and sandbox providers never get any of them. They only get grants.

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
