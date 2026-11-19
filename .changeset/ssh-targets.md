---
"beachside": minor
"@beachside/adapter": minor
"@beachside/boxd": minor
"@beachside/daytona": minor
"@beachside/upstash-box": minor
"@beachside/boat": minor
"@beachside/runloop": minor
---

Add provider-native SSH targets. `client.capabilities().ssh` reports whether the adapter returns them, without contacting the provider, and `box.sshTarget({ publicKey? })` resolves host, port, username, authentication, host keys, TLS proxy and expiry for a running sandbox. boxd, Daytona, Upstash Box, Boat and Runloop implement it; adapters without the hook report `unsupported`.
