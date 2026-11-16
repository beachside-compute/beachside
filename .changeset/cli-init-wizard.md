---
"@beachside/cli": minor
"@beachside/adapter": minor
"@beachside/daytona": patch
---

`beachside init` sets up providers. In a terminal it is a guided setup: pick several providers at once, paste each key (hidden), answer the adapter's own questions, keep new keys in the OS keychain, check that every provider accepts its key, try a sandbox on each, and save one profile per provider with one default. Everywhere else, and with `--json`, `--no-input`, `BEACHSIDE_NO_INPUT=1` or `CI`, it never asks: `beachside init <provider> --api-key env:NAME --set key=value` does the same job, exits 2 with `error.known.missing` when an answer is missing, and saves nothing when the provider rejects the key. The guided setup prints those commands at the end.

Credentials can now be `keychain://service/account` references, read from the macOS Keychain or a Linux Secret Service keyring. Adapter setup gains `defaults`, config a new profile starts with; Daytona's starts on the `daytona-small` image.
