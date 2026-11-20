---
"@beachside/archil": patch
"@beachside/cli": patch
---

Clearer Archil errors and setup hints from the 0.19.0 smoke test:

- A lifetime over the plan's cap (the Free plan's 30 minutes) is now `INVALID_ARGUMENT` with the cap named, instead of "sandbox is unsupported". The CLI hint suggests a shorter `--ttl`.
- When `--with` meets a provider that cannot give internet access (Archil's Free plan), the CLI says `--with` needs a plan or tier with internet access, since no other network policy can run it.
- Archil's setup lists its regions: `beachside init` offers them as choices, and `beachside providers`, `profile` output, missing-profile errors and `init` flag errors name them.
- `--with herdr` renames a sandbox whose hostname is its private IP (Archil) to its tailnet name, so Herdr no longer lists the host as "192".
