---
title: Agent skills
description: Install Beachside skills so coding agents know how to build with the SDK and drive sandboxes from the shell.
---

Beachside ships three agent skills from its repository: `beachside` and `beachside-cli` in [`skills/`](https://github.com/beachside-compute/beachside/tree/main/skills), and `add-provider` in [`.agents/skills/`](https://github.com/beachside-compute/beachside/tree/main/.agents/skills/add-provider). A skill is a `SKILL.md` file that an agent loads when a task needs it, so the guidance stays out of your prompt until it is useful.

| Skill           | Teaches an agent to                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beachside`     | Write application code with `beachside` and a provider adapter: connect, create and clean up sandboxes, run commands, move files, and handle uncertain outcomes without repeating work.                                                             |
| `beachside-cli` | Create, use and remove sandboxes from the shell with the `beachside` command, read its JSON output and exit codes, and clean up after failures.                                                                                                     |
| `add-provider`  | Write a provider adapter with `@beachside/adapter`: verify the account, map the shared setup options, implement create and destroy, test with `adapterSuite`, then package and document it. See [Write an adapter](/docs/guides/write-an-adapter/). |

## Install

### The CLI skill

If you use the `beachside` command, install `beachside-cli` with the CLI itself. It installs a short skill that tells the agent to read the guide with `beachside skill`, so the guide always matches your installed CLI and upgrading the CLI needs no rerun:

```sh
beachside skill setup            # for you, in every project
beachside skill setup --project  # for this repository only
beachside skill status           # where it is installed, and whether it is current
beachside skill remove           # remove what setup installed
```

Setup writes `.agents/skills/beachside-cli/`, which Codex, OpenCode, Pi and most other agents read, and `.claude/skills/beachside-cli/` when Claude Code is set up (it honors `CLAUDE_CONFIG_DIR`). `--agent claude|codex|opencode|pi` picks agents yourself, and `--dry-run` reports what would change. A copy written by an older CLI shows as `outdated`, and setup updates it. Setup and remove never touch a `beachside-cli` skill installed another way, such as with `npx skills add`; `setup --force` replaces it.

### The SDK and adapter skills

Install `beachside` and `add-provider` with the [`skills`](https://github.com/vercel-labs/skills) installer, which supports Claude Code, Codex, Cursor and other agents:

```sh
npx skills add beachside-compute/beachside --skill beachside -g
npx skills add beachside-compute/beachside --skill add-provider
```

`-g` installs the skill for your user. Leave it out to install into the current project instead, so everyone working in the repository gets it; that suits `add-provider`, which belongs in the adapter's repository.

The installer can also add `beachside-cli` (`npx skills add beachside-compute/beachside --skill beachside-cli -g`), for example before the CLI is installed. That copy holds the whole guide from the repository's main branch rather than your installed version, and the guide tells the agent to trust `beachside <command> --help` when they differ. Use `beachside skill setup` once the CLI is installed.

For an agent without a skill system, copy the `SKILL.md` contents into its project or user instructions.

Agents can also read these docs as Markdown. [`/llms.txt`](https://beachside.run/llms.txt) lists every page, and each page is at its address with `.md` in place of the trailing slash, such as `https://beachside.run/docs/agents/skills.md`.

## Credential broker skills

The [credential broker](/docs/credential-broker/) repository ships two more skills, for the trusted machine that runs the broker and launches sandboxes. Sandboxes never need them.

| Skill           | Teaches an agent to                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broker-setup`  | Deploy or update the broker on Cloudflare, add upstream integrations and set the issuance policy, leaving every key-handling step to you.               |
| `broker-grants` | Issue a short-lived grant for a sandbox job, pass it to the sandbox's tools and revoke it when the job ends, with an issuer key or GitHub Actions OIDC. |

```sh
npx skills add beachside-compute/credential-broker --skill broker-setup --skill broker-grants
```

With the `beachside` CLI, `beachside-cli` already covers sandboxes with grants (`create --grant`), so only `broker-setup` is needed.

`broker-setup` leaves deployment keys and upstream credentials to you: the agent never runs `deploy:setup`, prints `.env.deploy` or pipes a key itself. `broker-grants` keeps grant tokens in variables and out of the agent's output. The next section covers the Beachside skills only.

## What the skills do not do

The Beachside skills never hold credentials. The SDK skill reads keys from environment variables; the CLI skill uses your existing `beachside.json` profiles and tells the agent to leave configuration to you. Both tell the agent that live sandboxes cost money, to clean up what it creates, and never to retry an operation whose outcome is unknown.

For one-off tasks you can still paste the [SDK prompt](/docs/agents/build-with-sdk/) or the [provider integration prompt](/docs/agents/build-a-provider/) instead.
