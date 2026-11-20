---
"beachside": minor
"@beachside/cli": minor
---

Credential broker grants are easier to use and last longer.

- SDK: pass a grant with `grant:` on `sandboxes.create()` and `sandboxes.with()` (`credentials:` still works and is deprecated). `box.grant()` reports the grant's integrations, variables and expiry, and `box.renewGrant({ ttlSeconds })` extends it up to 7 days. Refused grants say how to fix them.
- CLI: `beachside broker add|ls|use|rm` connects the CLI to a broker, and `beachside broker status|integration|issuer|grant ...` manages it. `beachside create --grant <integration>` puts a grant in the sandbox's environment, so every later command and server sees it; `inspect` shows it, `beachside broker grant renew <sandbox>` extends it, and `rm` revokes it.
