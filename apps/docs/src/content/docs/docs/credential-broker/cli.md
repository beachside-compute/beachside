---
title: Use from the CLI
description: Connect the beachside CLI to a credential broker, give sandboxes grants with --grant, and renew or revoke them.
---

The `beachside` CLI talks to the broker for you. Grants it creates go into the sandbox's own environment, so every later `beachside exec`, `sh`, background process and `--with` server sees them, from any terminal.

Install the CLI and set up a sandbox provider, if you haven't. [CLI setup](/docs/cli/).

```sh
npm install -g @beachside/cli
beachside init
```

You also need a deployed broker. The [quickstart](/docs/credential-broker/quickstart/) deploys one in a few minutes.

## Connect a broker

Add the broker once per machine. Pass references so the keys stay in your password manager or environment, or read them from the broker's `.env.deploy`.

```sh
beachside broker add work --url https://broker.example.com \
  --issuer-key env:BEACHSIDE_BROKER_ISSUER_KEY \
  --admin-key op://infra/broker/admin

beachside broker add work --deployment ./credential-broker/.env.deploy
```

Keys accept the same forms as profile credentials: a value, `env:NAME`, `op://`, `bws://`, `pass://` or `keychain://`, or `-` to read one from stdin. A machine that only creates sandboxes needs just the issuer key. The CLI checks each key's role with the broker before saving. A key saved as a value makes `beachside.json` readable only by you.

```jsonc
// ~/.config/beachside/beachside.json
{
  "brokers": {
    "work": {
      "url": "https://broker.example.com",
      "issuerKey": "env:BEACHSIDE_BROKER_ISSUER_KEY",
      "adminKey": "op://infra/broker/admin",
    },
  },
  "defaultBroker": "work",
}
```

The first broker you add becomes the default. `beachside broker ls` lists them, `beachside broker use <name>` changes the default, and `--broker <name>` or `BEACHSIDE_BROKER` picks one per command. With no broker configured, the CLI uses `BEACHSIDE_BROKER_URL` and `BEACHSIDE_BROKER_ISSUER_KEY`, which suits CI.

## Create a sandbox with a grant

```sh
beachside create --name agent --network internet --grant github --grant openrouter
```

Each `--grant` names an integration. The variables it sets depend on the integration's kind:

| Integration                                       | Variables in the sandbox                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GitHub                                            | `git` and `gh` go through the broker. See [GitHub access](/docs/credential-broker/github/)                  |
| Anthropic, OpenAI or OpenRouter kind              | `ANTHROPIC_*`, `OPENAI_*` or `OPENROUTER_*`: `_BASE_URL` and `_API_KEY`                                     |
| HTTPS endpoint, which `integration setup` creates | `<ID>_BASE_URL` and `<ID>_API_KEY`. The `openrouter` ID sets `OPENROUTER_*`, `kilo-work` sets `KILO_WORK_*` |

To pick the names yourself, add them after the ID: `--grant openrouter=OPENAI_BASE_URL,OPENAI_API_KEY` points an OpenAI client at OpenRouter.

The grant lasts an hour unless you pass `--grant-ttl`, up to `7d`. It is part of the sandbox's environment, which the provider stores like any `--env` value; that is what lets later commands use it. Keep its lifetime as short as the work allows, and let `rm` revoke it. `--env` cannot override a variable the grant sets, and a sandbox with a grant is never saved as a setup cache, since the snapshot would keep the token. `beachside run --grant ...` works the same way and revokes the grant when it destroys the sandbox.

## Always-on agents

Give a long-running sandbox a 7-day grant and renew it before it lapses.

```sh
beachside create --name agent --network internet --with rex --grant github --grant openrouter --grant-ttl 7d
beachside broker grant renew agent --ttl 7d
```

Renewal keeps the same token, so processes already running in the sandbox keep working. An expired grant cannot be renewed: create the sandbox again. A scheduled `beachside broker grant renew` keeps an agent going indefinitely.

## See, renew and revoke

```sh
beachside inspect agent                    # integrations, variables and expiry, never the token
beachside broker grant list                # every grant this issuer key made, with use counts
beachside broker grant renew agent --ttl 2d
beachside broker grant revoke agent        # cut the sandbox off now, keep the sandbox
beachside rm agent                         # destroy the sandbox and revoke its grant
```

`grant renew` and `grant revoke` take a sandbox name or a grant ID. If `rm` cannot reach the broker, it still removes the sandbox and prints the grant ID to revoke, which otherwise expires on its own.

## Network access

The sandbox must reach the broker over HTTPS. `--grant` refuses `--network blocked`. Some providers restrict outbound traffic further: Daytona's Tier 1 and 2 only reach essential services, and shared hosting domains such as `workers.dev` are not on that list, so use Tier 3 or later, which can [allow your broker's domain](https://www.daytona.io/docs/en/network-limits). If a client in the sandbox times out, check the provider's network rules before the broker.

## Manage the broker

`beachside broker` runs every management command of the standalone `beachside-broker` command line, with the same names and flags, using the URL and keys saved by `broker add`. Pick a broker with `--broker <name>` rather than `--url`. On top of those, `grant renew` and `grant revoke` also take a sandbox name, and `add`, `ls`, `use` and `rm` manage the brokers this machine knows.

```sh
beachside broker status
beachside broker integration setup
beachside broker integration list
beachside broker issuer allow openrouter
beachside broker integration --help        # every command and flag
```

See [Operate the broker](/docs/credential-broker/operate/) for rotation, disabling and other tasks.
