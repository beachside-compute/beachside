---
"@beachside/cli": patch
---

`beachside broker` management commands refuse `--url`, so saved broker keys only go to the configured broker. Use `--broker <name>` to pick one.
