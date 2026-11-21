---
"@beachside/boxd": patch
---

A create whose machine boxd acknowledged, but whose follow-up call inside the boxd SDK failed, is now read back and verified like any other create. Before, it always ended as a partial outcome, even when the machine was fine.
