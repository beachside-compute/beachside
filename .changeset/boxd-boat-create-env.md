---
"@beachside/boxd": minor
"@beachside/boat": minor
---

boxd and Boat now support create-time `env` (`capabilities().createEnv`), so `create({ env })`, `beachside create --env` and `--grant` work there. boxd writes the variables to a private `/etc/beachside.env` that every command reads first, because boxd's own create-time env never reaches commands on a machine booted from an image; per-call `env` still wins. Boat sends them as its native per-sandbox env.
