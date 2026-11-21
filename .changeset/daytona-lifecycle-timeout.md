---
"@beachside/daytona": patch
---

Daytona create and delete requests now wait 60 seconds, as the official SDK does, so a slow placement is no longer reported as an unknown outcome that leaves a sandbox behind.
