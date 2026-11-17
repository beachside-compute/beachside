---
"@beachside/cli": minor
---

`beachside init` now keeps pasted or piped keys in `beachside.json` (mode 0600) by default on every platform, and the guided setup no longer asks where to store them. The OS keychain is still available with `--store keychain`, and existing `keychain://` references keep working.
