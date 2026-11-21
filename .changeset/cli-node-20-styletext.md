---
"@beachside/cli": patch
---

Run on every Node 20 release again. The bundled prompt library imported `styleText` from `node:util`, which only exists from Node 20.12, so the CLI failed to start on older Node 20 releases such as the one in E2B's default template. The build now routes that import through a small fallback.
