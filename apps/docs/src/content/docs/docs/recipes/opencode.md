---
title: Run OpenCode in a sandbox
description: Run OpenCode inside a Daytona or E2B sandbox, capture its answer, or edit a remote file.
---

Two small TypeScript applications run [OpenCode](https://opencode.ai) inside a disposable Daytona or E2B sandbox. They use the same public execution and file API with either provider; switching providers only changes setup.

| Workflow | What it does                                                                                                                                    | Source                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `hello`  | Asks OpenCode “What is 2 + 2?” and prints captured stdout/stderr.                                                                               | [Hello application](https://github.com/beachside-compute/beachside/blob/main/examples/agent-hello-world/main.ts)   |
| `edit`   | Uploads `message.txt`, asks OpenCode to replace `NAME` with `Beachside`, and reads back `Hello, Beachside!`. The local fixture stays unchanged. | [File-edit application](https://github.com/beachside-compute/beachside/blob/main/examples/agent-edit-file/main.ts) |

**Source:** [`examples`](https://github.com/beachside-compute/beachside/tree/main/examples). The [examples README](https://github.com/beachside-compute/beachside/blob/main/examples/README.md) covers model overrides, bounds and failure handling in more depth.

## Set up and run

Use **Bun 1.4.4** on the host. These examples live in the repository, so run them from a checkout:

```sh
git clone https://github.com/beachside-compute/beachside.git
cd beachside
bun install --frozen-lockfile
bun run build:packages
cp examples/.env.example examples/.env.local
```

Edit `examples/.env.local` with the selected provider's credentials. The scripts load this ignored file explicitly.

| Provider | Configuration                                              | Prerequisites                                                                                                                                                       |
| -------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daytona  | `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT`    | An active Linux snapshot in the target region. The connection selects `daytona-default`; organization policy must permit GitHub release downloads and model access. |
| E2B      | `E2B_API_KEY`; optional `E2B_TEMPLATE_ID` (default `base`) | A ready Linux template; creation explicitly selects `internet`.                                                                                                     |

The guest needs glibc-based Linux on x64 or arm64, `curl`, `tar`, `sha256sum`, `/bin/sh`, Python 3, and the adapter's [Daytona shell/file utilities](/docs/providers/daytona/#image-requirements) or [E2B file prerequisites](/docs/providers/e2b/#commands-and-files). The helper downloads pinned standalone **OpenCode 1.18.35** from GitHub and verifies its pinned SHA-256 digest. It does not need npm in the guest.

Run either workflow with either provider:

```sh
bun run --cwd examples hello --provider daytona
bun run --cwd examples edit --provider daytona
bun run --cwd examples hello --provider e2b
bun run --cwd examples edit --provider e2b
```

Each invocation creates one sandbox and attempts destruction in `finally`, then closes the client. `hello` normally prints an answer containing `4`; `edit` verifies the exact returned file bytes `Hello, Beachside!\n`.

## Model and lifetime

The explicit default is `opencode/nemotron-3.5-lightning-free`, an anonymous free model accepted in the recorded October 10, 2026 run. It needs no model API key. Availability can change; the README describes `OPENCODE_MODEL` and keyed-model overrides. Sandbox credentials stay on the host; only an explicitly named model key is forwarded to the guest. Sandbox compute can incur provider charges.

Sandbox lifetime is 600 seconds. Installation and agent deadlines are 120 and 180 seconds, with a 480-second overall workflow wait. Aborting a wait does not prove remote termination. Cleanup uses a separate 30-second destruction signal and 5-second client-close wait; failed cleanup reports the known sandbox ID. Uncertain operations retain a recovery reference and are not automatically replayed.
