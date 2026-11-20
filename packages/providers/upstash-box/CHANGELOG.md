# @beachside/upstash-box

## 0.19.0

### Minor Changes

- [#253](https://github.com/beachside-compute/beachside/pull/253) [`a1426a9`](https://github.com/beachside-compute/beachside/commit/a1426a9fca72ae2767ae00745a2c73a6ea99a5c7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the separately installed Upstash Box adapter for ephemeral and regular boxes, with live commands, binary files, snapshots, previews, and reopening by Box ID.

- [#257](https://github.com/beachside-compute/beachside/pull/257) [`49fec49`](https://github.com/beachside-compute/beachside/commit/49fec49fa4c7e7cc4d65dfee56cc6e78efe53a62) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add provider-native SSH targets. `client.capabilities().ssh` reports whether the adapter returns them, without contacting the provider, and `box.sshTarget({ publicKey? })` resolves host, port, username, authentication, host keys, TLS proxy and expiry for a running sandbox. boxd, Daytona, Upstash Box, Freestyle, exe.dev, Boat and Runloop implement it; adapters without the hook report `unsupported`.

### Patch Changes

- Updated dependencies [[`27307c6`](https://github.com/beachside-compute/beachside/commit/27307c618714fa6103901f8f31136faee3ffa3ff), [`49fec49`](https://github.com/beachside-compute/beachside/commit/49fec49fa4c7e7cc4d65dfee56cc6e78efe53a62)]:
  - @beachside/adapter@0.19.0
