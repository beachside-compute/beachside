# Provider smoke test

A short daily tripwire for the basics users hit first, on every supported provider: boxd,
Freestyle, Daytona, E2B, Archil and Upstash Box. It drives the real `beachside` CLI one process per
step, the way people and agents use it, so it catches what an in-process SDK test can't, such as
create-time env that only lived in the first client.

It complements the [qualification suites](../provider-qualification/README.md): those produce
reviewed evidence for the support table; this one answers "do the basics work today?" in a few
minutes, with one small sandbox (plus one short `run`) per provider. Its results are never
qualification evidence.

## Run it

```sh
bun run smoke                                   # every provider, CLI built from this checkout
bun run smoke -- --provider boxd,e2b            # a subset
bun run smoke -- --cli-version 0.19.0           # a released CLI and adapters from npm
bun run smoke -- --env-file ~/.config/x.env     # keys from another file
```

Keys come from the environment, then from `--env-file` (default `~/.config/beachside.env`), under
the names in [providers.json](providers.json). A provider without keys is reported as `no keys`
and not run. The grid prints at the end; scrubbed logs, JUnit and JSON go to `--report` (default a
new directory under the system temp directory).

One provider alone: `SMOKE_PROVIDER=e2b bun test packages/sdk-qualification/smoke/smoke.test.ts`.
Ordinary `bun test` skips it.

## What it checks

[probe.sh](probe.sh) is plain POSIX `sh`, so it runs on any image. It reports create-time env
(also from a child shell and login shells, and a value with spaces, quotes, `$`, a backslash and
non-ASCII), per-command env and which one wins, the user, tools, the clock, a marker file written
with `date`, and an HTTPS request to beachside.run with whichever client the image has.

[smoke.test.ts](smoke.test.ts) then checks, each as its own test: `doctor`; `create` with labels,
`--ttl 15m`, env and a setup step that runs `npm install -g @beachside/cli`; `inspect` and
`ls --remote` (state, expiry, labels); create-time env from a second CLI process; the file round
trip with `cp`; the installed CLI's version against npm; exit codes and stderr; `--cwd`; binary
`--stdin`; streaming before exit; `--timeout`; `cp -r` of a tree with a 5 MiB file both ways;
`push`; a one-shot `run`; `rm`; and that `gc` finds nothing left.

An adapter that refuses create-time env is reported `unsupported`, not `pass`. A failure a provider
is known to have goes in `exceptions` in [providers.json](providers.json) with its reason, and is
reported `restricted`.

## Cleanup

Every sandbox carries `ci=beachside-smoke` and `smoke=<run id>` labels and a 15 minute native TTL.
Each provider's run removes its own sandbox, then runs `gc` on its run label, and every run first
sweeps smoke sandboxes older than an hour. Archil sandboxes carry no labels, so for Archil the run's
own `rm` and the native TTL do the work.

## Credentials

The committed [beachside.json](beachside.json) holds no secrets: every credential is an `env:`
reference. Keys never enter a sandbox; the probe only sees random test values. Every log, report
and summary passes through [scrub.ts](scrub.ts), which removes the keys, their base64 and
URL-encoded forms, JWTs, `Authorization` values and known key prefixes. A scrub hit fails the run,
so the key can be rotated. The scheduled GitHub run lives in a private repository, so its logs are
not public.
