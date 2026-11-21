---
"@beachside/cli": patch
---

`create --grant` refuses before asking the broker when the provider has no sandbox-wide env (boxd today), instead of minting a grant and failing with an unrelated env error. `broker add` creates a `--config` / `BEACHSIDE_CONFIG` file that does not exist yet. `sh <sandbox> -` reads the script from stdin.
