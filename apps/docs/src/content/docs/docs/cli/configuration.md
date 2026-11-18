---
title: CLI configuration
description: Profiles, credentials, password managers, limits and where the beachside CLI keeps its state.
---

The CLI works with environment variables alone. For anything more, it reads `~/.config/beachside/beachside.json` (or `$XDG_CONFIG_HOME/beachside/beachside.json`). Point it elsewhere with `--config` or `BEACHSIDE_CONFIG`.

## Set up providers with init

`beachside init` writes profiles for you. In a terminal it is a guided setup; everywhere else, including with `--json`, `--no-input`, `BEACHSIDE_NO_INPUT=1` or `CI` set, it is an ordinary command that never asks anything and takes every answer as a flag:

```sh
beachside init e2b --api-key env:E2B_API_KEY --default
beachside init boxd --api-key env:BOXD_API_KEY --set org=org-123 --network internet
printf %s "$DAYTONA_KEY" | beachside init daytona --api-key - --set target=us
beachside init boxd --profile boxd-work --api-key op://Work/boxd/credential --set org=org-456
```

The flag form sets up one provider per call and installs its adapter if it is missing. The provider can also come from `--provider` or `BEACHSIDE_PROVIDER`. The profile is named after the provider unless you pass `--profile`, which is how you keep two accounts on one provider.

- **Keys.** `--api-key` (or `--credential <key>=<value>` for providers with other credentials, such as Modal's `tokenId`) takes `env:NAME`, an `op://`, `bws://`, `pass://` or `keychain://` reference, which is saved as written, or the key itself. A key itself is best piped in with `--api-key -`, so it stays out of your shell history; when several credentials are `-`, stdin holds one value per line, `--api-key` first and then each `--credential` in order. A provider with several credentials and none called `apiKey` takes them only as `--credential`. It is kept in `beachside.json`, readable only by you (`--store config`, the default). `--store keychain` puts it in your OS keychain instead (macOS Keychain, or Secret Service through `secret-tool` on Linux), and the profile keeps a `keychain://` reference. When you pass no key and the provider's variable is set, the profile uses `env:<that variable>`.
- **Settings.** `--set <key>=<value>` sets a config value (JSON values such as `true` or `{"kind":"prepared","value":"daytona-small"}` are parsed), and `--network` sets the `network` setting. A required setting you don't pass is copied from its environment variable. A profile starts with the adapter's own sensible defaults, such as Daytona's `daytona-small` image, so the first `create` works without extra flags.
- **Checks.** `init` connects and makes one listing read, as `doctor` does, and saves nothing if the provider rejects the key (exit 5). `--try` also creates a sandbox, runs one command and destroys it. `--no-check` skips the check, for setup without a network.
- **Reruns.** Running `init` again with the same answers, including the same piped key, reports `unchanged`. If the profile exists with other settings, it exits 2 and names them; `--force` replaces it. `init` never deletes a profile.
- **Default.** When no profile is the default yet, the new one becomes it; `--default` makes a later one the default.
- **Missing answers.** A missing key or setting exits 2 and lists the flags it needs in `error.known.missing`, with links to where to get each value. It never waits for input.
- **Other adapters.** `--module <package|path> --export <name> --profile <name>` sets up a third-party adapter from its own setup description.

With `--json`, the result includes where each credential comes from (never a key), the settings, the check results and `command`, the command that makes the same profile again. The guided setup prints those commands at the end. It takes `--no-check`, `--try`, `--store`, `--default` and `--force` too, and when you name a provider (`beachside init e2b --profile e2b-work`) it also takes that provider's `--profile`, `--api-key`, `--credential`, `--set` and `--network` and asks only the rest; a key given as `-` is for the flag form, since in a terminal stdin is your keyboard. The printed command doesn't carry a profile's [setups](#setups), which you list in `beachside.json`. Nothing is written to `beachside.json` until the end, and Ctrl-C before then leaves it as it was; adapters that were missing are installed first, before the questions, and stay installed.

## Environment-only setup

Set `BEACHSIDE_PROVIDER` (or pass `--provider`) and the provider's own variables:

| Provider    | Variables                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `boxd`      | `BOXD_API_KEY`, `BOXD_ORG`; optional `BOXD_NETWORK` and `BOXD_REGION`                                           |
| `freestyle` | `FREESTYLE_API_KEY`; optional `FREESTYLE_NETWORK`                                                               |
| `daytona`   | `DAYTONA_API_KEY`, `DAYTONA_TARGET`                                                                             |
| `boat`      | `BOAT_API_KEY`                                                                                                  |
| `runloop`   | `RUNLOOP_API_KEY`; optional `RUNLOOP_NETWORK` (experimental)                                                    |
| `e2b`       | `E2B_API_KEY`                                                                                                   |
| `archil`    | `ARCHIL_API_KEY`, `ARCHIL_REGION`; optional `ARCHIL_NETWORK` (`archil-managed` on the Free plan) (experimental) |
| `exe-dev`   | `EXE_API_KEY` (experimental)                                                                                    |
| `vercel`    | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                                                           |
| `modal`     | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_APP_NAME`, `MODAL_ENVIRONMENT`                                   |

`beachside providers` shows which of these are missing once the adapter is installed, with a link to where you get each one when the adapter gives one. It reads them from the installed adapter, so it loads that package. Each adapter declares its own variables, so a third-party adapter that declares them works env-only too. `BOXD_ORG` is the ID (`org-…`) of the boxd org your API key belongs to; `boxd auth --json` lists your orgs with their IDs (the active one has `"active": true`). Daytona has no default image, so each env-only Daytona `create` or `run` needs `--prepared <snapshot>` (such as `daytona-small`) or `--image`; a profile made by `beachside init` already sets `daytona-small`. `BOXD_REGION` (such as `nyc`) picks a boxd region other than your org's home one. Sandboxes reach the internet by default; set a provider's `*_NETWORK` variable to `blocked` (or put an allowlist in a profile's config) to restrict it.

## Profiles

A profile is one adapter's setup under a name. You can keep as many as you like, one per provider or account, and pick one per command with `--profile`. Its `config` and `credentials` are that adapter's own settings, as described on each [provider page](/docs/providers/support/). `beachside profile show` prints `config` values as written, so keep keys and tokens in `credentials`:

```json
{
  "$schema": "https://beachside.run/schema/beachside.json",
  "default": "e2b",
  "profiles": {
    "e2b": {
      "provider": "e2b",
      "credentials": { "apiKey": "env:E2B_API_KEY" }
    },
    "daytona-us": {
      "provider": "daytona",
      "credentials": { "apiKey": "op://Dev/Daytona/credential" },
      "config": { "target": "us", "network": "daytona-default" }
    },
    "local": {
      "module": "./my-adapter.js",
      "export": "myAdapter",
      "config": {},
      "credentials": {}
    }
  },
  "limits": { "maxSandboxes": 10 }
}
```

The CLI picks a profile from `--profile`, then `BEACHSIDE_PROFILE`, then `--provider`, then `BEACHSIDE_PROVIDER`, then `default`. Environment variables fill in an official provider's settings, and values in the profile override them.

`provider` names an official adapter (`@beachside/<provider>`). `module` and `export` load any other adapter, either an adapter definition or an already configured adapter; a relative path is relative to `beachside.json`.

Each sandbox remembers the profile that created it, so later commands on it use the same profile whatever is selected now.

The `$schema` line is optional. With it, editors such as VS Code complete and check the file against [the published schema](https://beachside.run/schema/beachside.json). `beachside schema config` prints the same schema for the CLI you have installed.

### Manage profiles

```sh
beachside profile ls              # every profile; * marks the one a command would use now
beachside profile show daytona-us # where each setting comes from; credentials are never shown
beachside profile use daytona-us  # make it the default
beachside profile rm old-e2b      # remove one
```

`profile show` reads nothing from a password manager and doesn't contact the provider, though it loads the adapter package to learn what the adapter needs. It says whether each value is written in the file (credentials show as hidden), read from an environment variable, or a password-manager reference, and which required values are missing. Without a name it shows the profile a command would use now; an official provider id shows its environment-only setup.

`profile use` and `profile rm` rewrite `beachside.json` with two-space indentation and keep the file's permissions. `profile rm` refuses while stored sandboxes, snapshots or images were made with the profile, since the CLI could no longer reach them; `--force` removes it anyway. Removing the default profile leaves no default until you pick one.

To let a profile's sandboxes reach only some destinations, give its `config` an [egress allowlist](/docs/guides/images-and-networking/#allow-only-some-destinations), for example `"config": { "network": { "allow": ["registry.npmjs.org", "*.github.com"] } }`. Every sandbox from that profile uses the list, and `--network internet` or `--network blocked` rejects, so use another profile for those.

## Setups

`setups` names setup steps that `--setup <name>` runs after a sandbox starts, and a profile's `setup` lists the ones its sandboxes get by default:

```json
{
  "profiles": { "e2b": { "provider": "e2b", "setup": ["node"] } },
  "setups": {
    "node": { "setup": ["fnm install 22"], "network": "internet" }
  }
}
```

See [Set up a sandbox](/docs/cli/setup/) for steps, startup, env and failures. `"projectSetups": true` (or `BEACHSIDE_PROJECT_SETUPS=1`) also reads setups from a checkout's `.beachside/setup.json`.

## Credentials

A credential can be written four ways:

- **Directly** in `beachside.json`. Keep the file private (`chmod 600`); files `init` and `profile` commands create are.
- **`env:NAME`**, read from an environment variable when the profile is used.
- **A `keychain://service/account` reference** to your OS keychain, which is where `beachside init --store keychain` keeps new keys.
- **A password-manager reference**, read through that manager's own CLI only when the profile connects. The value is never written anywhere.

| Reference                    | Read with                                                                            | Sign-in                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `op://vault/item/field`      | `op read` (1Password CLI)                                                            | Desktop app integration, `op signin` or `OP_SERVICE_ACCOUNT_TOKEN` |
| `bws://<secret-id>`          | `bws secret get` (Bitwarden Secrets Manager)                                         | `BWS_ACCESS_TOKEN`                                                 |
| `pass://path/to/entry`       | `pass show`, first line of the entry                                                 | Your GPG agent                                                     |
| `keychain://service/account` | `security find-generic-password` on macOS, `secret-tool lookup` (libsecret) on Linux | Your login keychain or keyring, unlocked                           |

References also work in a provider's environment variable, for example `E2B_API_KEY=op://Dev/E2B/credential`. If the manager's CLI is not installed the command exits 4; if it can't read the secret it exits 5 and shows the manager's own message.

## Limits

`limits.maxSandboxes` (or `BEACHSIDE_MAX_SANDBOXES`) caps how many sandboxes the CLI will keep at once. A `create` or `run` over the cap exits 4 before contacting the provider. There is no cap unless you set one. The check is a safety net, not a guarantee: two creates started at the same moment can both pass it.

## Image builds

E2B and Daytona build an OCI image into a provider template or snapshot before a sandbox can start from it. By default `create --image` and `run --image` use only builds recorded with `beachside image build`, and fail before creating anything otherwise. A profile whose `config.environment` names an OCI image follows the same rule when you pass neither flag. `"images": { "autoBuild": true }` builds a missing image on demand instead, once per reference and profile. Leave it off for agents that run `--image` in a loop unattended: each new reference starts a slow build that may cost money and leaves a provider-side resource.

## Where adapters are loaded from

Adapters receive your credentials, so the CLI loads them only from `~/.config/beachside/adapters` or from its own installation. `beachside adapter add` installs into that folder, which is its own small npm project with a `package.json`.

Third-party adapters install the same way, by package name: `beachside adapter add @acme/beachside-adapter@1.2.0`, or `npm:acme-beachside` for a package without a scope. A bare name that is not an official provider is refused, so a typo never installs an unrelated package that would then receive your credentials. Point a profile at the package with `"module": "@acme/beachside-adapter"` and the export that holds the adapter (`adapter add` prints the names it found). To use adapters installed in the current project's `node_modules`, opt in with `"adapters": { "searchProject": true }` in `beachside.json` or `BEACHSIDE_PROJECT_ADAPTERS=1`.

## State

The CLI remembers each sandbox as a small JSON file in `~/.config/beachside/state/sandboxes/<name>.json`. The file holds the provider's reference to the sandbox, never credentials.

Use a different folder with `--state-dir` or `BEACHSIDE_STATE_DIR` (relative to the current directory), or `"state": { "kind": "fs", "dir": "..." }` in `beachside.json` (relative to that file). A separate folder per project or per CI job keeps their sandboxes apart.

The name is recorded before the provider is called. If a create fails in a way that may still have made a sandbox, the record stays with status `unknown`, so `beachside ls` shows it. The record also keeps the SDK's recovery reference for that create, so `beachside rm <name>` and `beachside inspect <name>` first ask the provider how the original request ended, without sending it again. If the sandbox exists, `rm` destroys it. If the provider still cannot say, check it yourself; `beachside rm --force <name>` then drops the record.

Concurrent `beachside` processes on one machine can share a state folder safely.
