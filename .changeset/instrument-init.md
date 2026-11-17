---
"@beachside/cli": patch
---

`beachside init` now sends the same basic usage event as other commands, recording whether it ran as the guided setup or from flags. Provider keys, settings and other values are never sent.
