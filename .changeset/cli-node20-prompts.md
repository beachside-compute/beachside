---
"@beachside/cli": patch
---

The CLI starts on every Node 20 release again. The prompt library behind `beachside init` and the credential broker's command line imports `styleText` from `node:util`, which Node before 20.12 lacks (for example the Node 20.9 in E2B's default template). The build hoisted that import to the top of the bundle, so every command failed to load there. Both are now loaded only when they run, into their own chunk: the guided `beachside init` and `beachside broker` management commands need Node 20.12 or newer, and the broker commands say so plainly, while every other command runs on any Node 20.
