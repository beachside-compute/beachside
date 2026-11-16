# Run OpenCode with Beachside

Three small TypeScript applications run OpenCode in a sandbox. `hello` and `edit` use Daytona or E2B; `box` also runs on boxd, Freestyle, Vercel and Runloop:

- `hello` asks **“What is 2 + 2?”** and prints captured stdout/stderr. It does not create an answer file.
- `edit` uploads [message.txt](agent-edit-file/message.txt), asks OpenCode to replace `NAME` with `Beachside`, then reads and displays the changed remote file. The local fixture stays unchanged.
- `box` runs an OpenCode 2 server next to your project in a sandbox and attaches your local OpenCode to it; see [OpenCode 2 in a box](#opencode-2-in-a-box).

All three use Beachside's public SDK. Provider selection changes setup; the workflows use the same execution and file calls.

## Setup

Use **Bun 1.3.14** from the repository root:

```sh
bun install --frozen-lockfile
bun run build:packages
cp examples/.env.example examples/.env.local
```

Edit `examples/.env.local` with the credentials for your selected sandbox provider. The scripts explicitly load that file; it is ignored by Git.

| Provider | Required configuration | Image and network prerequisites |
| --- | --- | --- |
| Daytona | `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT` | An active Linux snapshot in your target region. `daytona-default` is selected on the connection; your organization's policy must permit GitHub release downloads and model endpoints. |
| E2B | `E2B_API_KEY`; optional `E2B_TEMPLATE_ID` (default `base`) | A ready Linux template. Creation explicitly requests `internet`. |

The guest image needs glibc-based Linux on x64 or arm64, `curl`, `tar`, `sha256sum`, `/bin/sh`, Python 3 and the adapter's standard shell/file utilities; see the [Daytona](../apps/docs/src/content/docs/docs/providers/daytona.md#image-requirements) and [E2B](../apps/docs/src/content/docs/docs/providers/e2b.md#files-and-commands) guides. The guest working directory is `/tmp/beachside-agent-example`. OpenCode is installed under its `opencode/` subdirectory. Installation downloads the pinned standalone binary from GitHub releases (the x64 baseline build avoids an AVX2 requirement) and verifies its pinned SHA-256 digest before extraction. It requires outbound GitHub access; model execution needs access to the selected model service.

## Model selection

The helper pins **OpenCode `1.18.35`** and explicitly selects **`opencode/nemotron-3.5-lightning-free`** by default. This model is listed in OpenCode's current public catalog and [Zen documentation](https://opencode.ai/docs/zen/) as an anonymous free option (checked October 10, 2026). No model API key is required for this default. Availability can change; override `OPENCODE_MODEL` when selecting another supported model.

```dotenv
OPENCODE_MODEL=opencode/nemotron-3.5-lightning-free
```

The deprecated `exo-free` model is not used.

Sandbox credentials stay on the host. For a keyed model, set `OPENCODE_MODEL` to its `provider/model-id` and set `OPENCODE_API_KEY_ENV` to the name of its credential variable, for example:

```dotenv
OPENCODE_MODEL=anthropic/your-model-id
OPENCODE_API_KEY_ENV=ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=your-model-key
```

The chosen model key is accessible to agent tools inside the sandbox; use a scoped, short-lived key for these trusted demo prompts.

Use an available model ID accepted by the pinned OpenCode version. The helper copies only that named model key into the guest; it rejects sandbox credential names. Model service charges depend on your selected model; sandbox compute can incur provider charges even with an anonymous free model.

## Run

Choose either provider for either example:

```sh
bun run --cwd examples hello --provider daytona
bun run --cwd examples edit --provider daytona
bun run --cwd examples hello --provider e2b
bun run --cwd examples edit --provider e2b
```

Each invocation creates one new sandbox. `hello` prints the agent's answer, normally containing `4`; model wording and CLI decoration can vary. `edit` prints agent output followed by the exact file contents:

```text
Hello, Beachside!
```

The file example fails if the returned file differs from `Hello, Beachside!\n`. Captured agent stdout and stderr are forwarded to the corresponding local streams. Installation has a 16 KiB output bound; agent output has a 64 KiB bound, and truncated output fails the example.

## Lifecycle and validation

OpenCode uses [`run --pure`](https://opencode.ai/docs/cli/) with editing permissions enabled inside the disposable sandbox, sharing disabled and automatic updates disabled. Its configuration/data/cache/state directories live under the example working directory.

The sandbox lifetime is 600 seconds. Installation and agent calls have 120-second and 180-second deadlines, with a 480-second overall workflow wait. These bounds do not establish remote process termination at a deadline. Each entrypoint uses `client.sandboxes.with(setup.create, callback, { signal: run.signal })` to own one sandbox. Ctrl+C aborts local callback waiting and attempts destruction with a fresh 30-second cleanup budget, then the example closes its caller-owned client with a separate 5-second wait. The callback passes the work signal into all SDK calls; a callback ignoring cancellation can continue after local waiting ends. `SandboxCleanupError` preserves the completed callback value or original failure, cleanup failure, known sandbox identity and destroy recovery reference. The reporter serializes work and cleanup operation references separately; investigate them without automatically replaying uncertain work. Scope cleanup honors the connection's storage policy and never deletes retained volumes or snapshots. Manual create/destroy remain available.

Live acceptance passed on October 10, 2026 at source revision `1446cf0a013a6a2b49a65f7c419dabc3b67302bf`, using host Bun 1.3.14, standalone OpenCode 1.18.35 and anonymous `opencode/nemotron-3.5-lightning-free`:

| Provider | Passing configuration | Verified results |
| --- | --- | --- |
| Daytona | Existing `daytona-small` snapshot, `us` target, `daytona-default` network | Answer contained `4`; remote file was exactly `Hello, Beachside!\n`. |
| E2B | Existing `base` template, `internet` network | Answer contained `4`; remote file was exactly `Hello, Beachside!\n`. |

The live harness imported the actual `hello`, `edit`, installation, provider setup and cleanup functions and ran both workflows sequentially in one owned sandbox per provider. It did not rerun all four standalone CLI invocations above. Initial attempts using npm failed because Daytona lacked npm and E2B's npm install exited 137; the corrected standalone installer passed. All four allocated sandboxes, including those initial attempts, were independently confirmed deleted by provider GET responses returning 404. These results qualify these workflows and configurations at that revision. Offline fixtures cover SDK wiring and failure cleanup; future live sandbox runs require separate authorization.

## OpenCode 2 in a box

`box` puts your project and an OpenCode 2 server in one sandbox, then attaches your local OpenCode 2 client to it. The agent's commands and edits run in the sandbox; you drive it from your own terminal. Pull the work back when you are done.

```sh
bun run --cwd examples box up --provider e2b --project ~/code/my-app
bun run --cwd examples box attach
bun run --cwd examples box pull
bun run --cwd examples box down
```

`--project` takes any directory in a git checkout; relative paths resolve from `examples/`, so prefer an absolute path. `--provider` is `daytona`, `e2b`, `boxd`, `freestyle`, `vercel` or `runloop`. Pass `--name <name>` to run several boxes, and `--hours <n>` to `up` for a lifetime other than one hour (24 at most).

**Up** creates the sandbox and downloads **OpenCode `2.2.3`** for Linux straight from the npm registry tarball, checking its pinned SHA-256 digest (no Node or npm in the guest). It uploads your project's tracked files, untracked files that are not ignored, and `.git` to the same absolute path in the sandbox, so the local client and the server agree on the directory. It copies your git `user.name` and `user.email`, starts `opencode2 serve` on port 4096 with a random password, and waits until its API answers with that password through the provider's preview URL. The sandbox reference and password are saved under `~/.local/state/beachside-opencode-box/`, readable only by you.

**Attach** reopens the sandbox and runs your local `opencode2 --server` against a localhost proxy. The proxy adds the provider's preview headers (Daytona's and Runloop's preview tokens), which the OpenCode client cannot send itself, and refuses redirects so those headers cannot leak. Install the client with `npm install -g @opencode/cli`.

**Pull** copies the project back over your checkout, `.git` included, so commits the agent made appear in your local `git log`. Files the agent deleted stay on your side. It refuses to run while your checkout has uncommitted changes; pass `--force` to overwrite them anyway. **Down** destroys the sandbox and forgets it.

### Git and GitHub

Set `GH_TOKEN` in `examples/.env.local` to let the agent fetch, rebase and push to GitHub from the sandbox. `up` passes it to the OpenCode server, so the agent's commands inherit it, and configures git to use it for `https://github.com`. Use a fine-grained token limited to the repository: every command in the sandbox, the agent's included, can read it. `gh pr create` and other `gh` commands also need `gh` in the image (for example an E2B template or Daytona snapshot with it installed); without it, plain `git push` still works.

### Providers

Each provider needs its credentials in `examples/.env.local`. Every box gets open internet egress (OpenCode's download and your model service) and a preview route to port 4096.

| Provider | Variables | Notes |
| --- | --- | --- |
| `daytona` | `DAYTONA_API_KEY`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT` | Protected previews; the proxy sends the token. Egress follows `daytona-default`, which must allow `registry.npmjs.org` and your model service. |
| `e2b` | `E2B_API_KEY`, optional `E2B_TEMPLATE_ID` | Public previews. |
| `boxd` | `BOXD_API_KEY`, `BOXD_ORG`, optional `BOXD_REGION` | Routes port 4096 publicly. |
| `freestyle` | `FREESTYLE_API_KEY` | Public `style.dev` preview on port 4096. |
| `vercel` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Publishes port 4096 on the universal image. |
| `runloop` | `RUNLOOP_API_KEY` | Protected previews; the proxy sends the token. |

On public previews anyone with the URL reaches the server, so the random server password is the only gate for its API. Modal and Boat are missing because their adapters have no previews.

### Models

The server uses `OPENCODE_MODEL` when set, otherwise OpenCode's default. A keyed model works as above: `OPENCODE_API_KEY_ENV` names the one key that reaches the sandbox, where the agent can read it.

### Requirements and limits

The guest needs Linux on x64 or arm64 with `curl`, `sha256sum`, GNU `tar`, `git`, `setsid` and `/bin/sh`, outbound access to `registry.npmjs.org` and your model service, and `sudo` when the project path does not exist and the sandbox user cannot create it. The host needs `git` and `tar`. The box keeps running until `down` or its lifetime ends, and is billed meanwhile; sandboxes carry the labels `example=opencode-box` and `opencode-box=<name>`, so `beachside gc --label example=opencode-box` finds strays.

`up`, `pull` and `down` passed live on E2B (`base` template) on November 8, 2026: the server kept running after `up`, its API answered with the password through the preview proxy, and `pull` brought a commit made in the box back to the checkout. Not yet run live: an agent edit with a keyed model, the interactive `attach` client, and the other providers.

For offline checks after package builds:

```sh
bun run --cwd examples check
bun run --cwd examples test
```
