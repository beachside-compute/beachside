---
"@beachside/cli": patch
---

The CLI no longer prints a profile's credentials when an adapter or provider quotes them in an error. Resolved credential values, and their base64 and URL-encoded forms, are replaced with `[redacted]` in every message, `--json` envelope and crash report the CLI writes. Remote command output is passed through untouched.

The CLI runs on every Node 20 release again: `beachside broker add --deployment` used `node:util` `parseEnv`, which Node before 20.12 lacks (for example the Node 20.9 in E2B's default template), so the CLI failed to start there. It now reads the file with the same parser as `--env-file`.
