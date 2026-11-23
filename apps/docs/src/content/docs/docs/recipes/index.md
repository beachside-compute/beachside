---
title: Recipes
description: Complete, runnable applications built on Beachside, from a pull request reviewer to traced Pi runs and OpenCode in a sandbox.
---

Each recipe is a working application in the [`examples`](https://github.com/beachside-compute/beachside/tree/main/examples) directory of the Beachside repository. The pages below say what each one does, what it needs, and how to run it. Every recipe cleans up the sandboxes it creates, even when a run fails.

| Recipe                                                   | What it does                                                                                                                                                                                               | Runs on            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [Review pull requests with Pi](/docs/recipes/pr-review/) | A GitHub Actions job that posts one review per pull request: a summary plus inline comments. GitHub and model access come from a credential broker grant, so the repository holds no GitHub or model keys. | Freestyle          |
| [Trace a Pi run](/docs/recipes/pi-tracing/)              | Runs the Pi agent locally or in a sandbox and exports one OpenTelemetry trace covering the host, the Beachside SDK calls and Pi's model and tool calls.                                                    | Your machine, boxd |
| [Run OpenCode in a sandbox](/docs/recipes/opencode/)     | Asks OpenCode a question and captures its answer, or has it edit an uploaded file and reads the result back.                                                                                               | Daytona, E2B       |

All recipes run from a checkout of the repository with [Bun](https://bun.sh) installed:

```sh
git clone https://github.com/beachside-compute/beachside.git
cd beachside
bun install --frozen-lockfile
bun run build:packages
```

Each recipe page lists anything else it needs, such as an env file or provider keys.
