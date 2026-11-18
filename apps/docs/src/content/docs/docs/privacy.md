---
title: Privacy
description: The SDK does not track usage. Learn what the website and CLI telemetry collect and how to turn them off.
---

**The Beachside SDK and provider packages do not track your usage or send telemetry to Beachside. Only the CLI collects basic usage telemetry.**

## Website analytics

The docs and the `/beta/` and `/remote/` pages ask before recording anything. Until you accept, they send no analytics and set no analytics cookies. If you accept, they use PostHog to record page views, clicks and errors, and the `/beta/` and `/remote/` pages also load the Reddit Pixel so we can measure our Reddit ads. A beta signup or a copied install command is reported as a conversion. Your email address is never sent to PostHog or Reddit.

To change your choice, use **Analytics preferences** at the bottom of the page. Rejecting stops capture and removes the stored analytics data.

## CLI telemetry

Telemetry is enabled by default outside CI. It helps us understand command and provider usage and identify failures.

Events include the command (for `init`, whether it ran as the guided setup or from flags), provider category, outcome, fixed error category, duration bucket, CLI version, operating system, architecture, runtime major version, and whether the command ran in CI or a terminal. A random, locally stored installation ID recognizes returning installations. Events go to a dedicated Beachside CLI PostHog project.

We do not collect command arguments, input/output, file paths, environment variables, credentials, sandbox names or IDs, raw error messages, or stack traces. Help, version, completion, and telemetry controls send no events.

## Disable telemetry

```sh
beachside telemetry disable
```

Or set `BEACHSIDE_TELEMETRY=0` or `DO_NOT_TRACK=1`. When disabled, no telemetry requests are sent. CI collection stays off unless explicitly enabled.

Use `beachside telemetry status` to check your preference or `beachside telemetry enable` to enable it again. Preferences and the installation ID are stored under `$XDG_CONFIG_HOME/beachside` (default `~/.config/beachside`).
