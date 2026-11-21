---
"@beachside/cli": patch
---

The CLI no longer prints a profile's credentials when an adapter or provider quotes them in an error. Resolved credential values, and their base64 and URL-encoded forms, are replaced with `[redacted]` in every message, `--json` envelope and crash report the CLI writes. Remote command output is passed through untouched.
