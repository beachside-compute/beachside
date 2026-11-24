# @beachside/archil

## 0.22.1

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.22.1

## 0.22.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.22.0

## 0.21.1

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.21.1

## 0.21.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.21.0

## 0.20.0

### Patch Changes

- [#258](https://github.com/beachside-compute/beachside/pull/258) [`98df2b8`](https://github.com/beachside-compute/beachside/commit/98df2b8ee3cd7609892aea88b6d770c251a744ac) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Clearer Archil errors and setup hints from the 0.19.0 smoke test:

  - A lifetime over the plan's cap (the Free plan's 30 minutes) is now `INVALID_ARGUMENT` with the cap named, instead of "sandbox is unsupported". The CLI hint suggests a shorter `--ttl`.
  - When `--with` meets a provider that cannot give internet access (Archil's Free plan), the CLI says `--with` needs a plan or tier with internet access, since no other network policy can run it.
  - Archil's setup lists its regions: `beachside init` offers them as choices, and `beachside providers`, `profile` output, missing-profile errors and `init` flag errors name them.
  - `--with herdr` renames a sandbox whose hostname is its private IP (Archil) to its tailnet name, so Herdr no longer lists the host as "192".

- Updated dependencies []:
  - @beachside/adapter@0.20.0

## 0.19.0

### Patch Changes

- [#256](https://github.com/beachside-compute/beachside/pull/256) [`8533a40`](https://github.com/beachside-compute/beachside/commit/8533a4058ba0637536ce50f3035bc53715093dc2) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Archil is now a supported provider, out of experimental in the docs and on the landing page, after passing Beachside's live qualification on the Free plan. `makeDirectory` on an existing file now rejects with INVALID_ARGUMENT and no effect, recursive or not, instead of an unknown outcome. `renew()` and `resume()` now report the new session deadline, which Archil itself does not return.

- [#254](https://github.com/beachside-compute/beachside/pull/254) [`519d61a`](https://github.com/beachside-compute/beachside/commit/519d61ae9a27be2b0fdc148fdaf63c00b2f9a682) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - READMEs: E2B, Freestyle and Archil no longer describe an API-key fingerprint in scope (removed in 0.18.0), and the SDK reopen example shows the fresh `Beachside.connect` call.
- Updated dependencies [[`27307c6`](https://github.com/beachside-compute/beachside/commit/27307c618714fa6103901f8f31136faee3ffa3ff), [`49fec49`](https://github.com/beachside-compute/beachside/commit/49fec49fa4c7e7cc4d65dfee56cc6e78efe53a62)]:
  - @beachside/adapter@0.19.0

## 0.18.0

### Minor Changes

- [#251](https://github.com/beachside-compute/beachside/pull/251) [`720d4f7`](https://github.com/beachside-compute/beachside/commit/720d4f73b6a8108ac4621407fe5076393fd9b535) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - **Breaking:** E2B, Freestyle and Archil scopes no longer fingerprint the API key. Each provider authorizes every call with the current key, so scope is now the service plus its endpoint (and region for Archil), and saved references keep working after a key rotation. E2B also drops the default template from its scope and sandbox markers. References and E2B sandboxes saved by earlier versions do not reopen; recreate them.

  `adapterSuite` fixtures can now omit `alternate` when a provider has one fixed endpoint, and can pass `rotatedCredentials` to check that another key for the same account keeps the scope.

### Patch Changes

- Updated dependencies [[`720d4f7`](https://github.com/beachside-compute/beachside/commit/720d4f73b6a8108ac4621407fe5076393fd9b535)]:
  - @beachside/adapter@0.18.0

## 0.17.1

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.17.1

## 0.17.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.17.0

## 0.16.1

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [[`4f6ad78`](https://github.com/beachside-compute/beachside/commit/4f6ad7836c2f10c3cbcf7c02adbb7428052e2702)]:
  - @beachside/adapter@0.16.0

## 0.15.0

### Minor Changes

- [#212](https://github.com/pandemicsyn/beachside/pull/212) [`6c5d263`](https://github.com/pandemicsyn/beachside/commit/6c5d2632ef0d8a6c02d35fcd826112822b4768f6) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Sandboxes now reach the internet unless you ask otherwise. boxd, E2B, Vercel, Modal, Runloop, Freestyle and Archil default to `network: "internet"` instead of `blocked`; set `network: "blocked"` or an allowlist to restrict egress. Daytona keeps its tier-managed `daytona-default`. Boat and exe.dev no longer require `network: "internet"` in setup, and the CLI no longer needs `BOAT_NETWORK` or `EXE_NETWORK`; `BOXD_NETWORK`, `RUNLOOP_NETWORK`, `FREESTYLE_NETWORK` and `ARCHIL_NETWORK` stay optional, for `blocked` or (Archil Free plan) `archil-managed`. An adapter that declares no `defaultNetworkPolicy` now defaults to `internet`, or to its only policy when `supports.network` lists one. Connections that relied on the old blocked default and reopen sandboxes created that way should set `network: "blocked"` explicitly.

### Patch Changes

- [#211](https://github.com/pandemicsyn/beachside/pull/211) [`8652541`](https://github.com/pandemicsyn/beachside/commit/86525413252c43b170eb5e086b5f859713aa2ca9) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Adapters can declare `setup`: the environment variable for each credential and config setting, a description, and a link to where a person gets it when there is one. `alternatives` lists credentials that stand in for each other (exe.dev takes an API key or an SSH key). Every official adapter now declares its own, and the CLI reads them from the installed adapter instead of keeping its own table, so third-party adapters that declare `setup` get environment-only settings too. Missing-setting errors and `beachside providers` link to where each value comes from, and `providers` lists the profiles that use each provider. Its JSON rows add `known` (false when the adapter failed to load or declares no setup, in which case `missingEnv` is empty and the text says the settings are unknown) and `needs`, with each missing value's description and link.

  New `beachside profile ls | show | use | rm` commands list profiles, explain where each setting comes from without revealing credentials, change the default and remove profiles. `profile show` reports `ready` (true, false, or null when the adapter declares no setup) and what the profile still `needs`. `use` and `rm` rewrite `beachside.json` atomically under a lock, keeping its file mode. `profile rm` refuses while stored sandboxes, snapshots or images use the profile, unless `--force`.

  `beachside.json` has a published JSON Schema (https://beachside.run/schema/beachside.json, also printed by `beachside schema config`), and the file accepts a `$schema` key so editors can complete and check it. The schema requires each profile to name a `provider` or a `module`.

  `beachside doctor` now checks that the provider accepts the credentials with one read of its sandbox listing. A rejected key exits 5 (`UNAUTHENTICATED` or `FORBIDDEN`) with the profile name and where to get a new key, here and on any command that connects, instead of an internal error with an unknown outcome.

  `beachside providers` no longer marks boxd and Freestyle experimental, and lists providers in the docs' order.

- Updated dependencies [[`8652541`](https://github.com/pandemicsyn/beachside/commit/86525413252c43b170eb5e086b5f859713aa2ca9), [`6c5d263`](https://github.com/pandemicsyn/beachside/commit/6c5d2632ef0d8a6c02d35fcd826112822b4768f6)]:
  - @beachside/adapter@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.14.0

## 0.13.0

### Minor Changes

- [#194](https://github.com/pandemicsyn/beachside/pull/194) [`f95dce3`](https://github.com/pandemicsyn/beachside/commit/f95dce3c58353ed8ea14b23c5205f1619e4e374b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Egress allowlists: set `network: { allow: ["registry.npmjs.org", "*.github.com", "10.0.0.0/8"] }` in adapter setup to let sandboxes reach only those hosts and IPv4 ranges. Supported on E2B, Vercel, Modal, Runloop, Archil (paid plans), Daytona (Tier 3+; hosts or ranges, not both) and Freestyle (IPv4 ranges only); where the provider reports the list back, the adapter checks it recorded exactly that list. Modal also gains `network: "internet"`; it previously always blocked egress.

- [#198](https://github.com/pandemicsyn/beachside/pull/198) [`f89fde4`](https://github.com/pandemicsyn/beachside/commit/f89fde43eb1e548fad65c5da7b8e2c9328b62383) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `box.fork()`, `box.submitFork()` and `box.checkFork()`. A fork copies a running sandbox with the provider's native fork; adapters without one reject with `UNSUPPORTED`, and Beachside never emulates a fork with a snapshot and restore. `capabilities().fork` reports what a fork keeps, how the source is interrupted, whether processes resume and whether the fork's lifecycle is independent. boxd, E2B and Archil fork natively with memory and running processes. Adapters declare a fork with the new `sandboxFork` session hook; uncertain forks recover through operation kind `sandbox_fork`.

### Patch Changes

- Updated dependencies [[`f95dce3`](https://github.com/pandemicsyn/beachside/commit/f95dce3c58353ed8ea14b23c5205f1619e4e374b), [`9e3ab39`](https://github.com/pandemicsyn/beachside/commit/9e3ab396c38a718c9f26693073d6b6c93ad80972), [`f89fde4`](https://github.com/pandemicsyn/beachside/commit/f89fde43eb1e548fad65c5da7b8e2c9328b62383)]:
  - @beachside/adapter@0.13.0

## 0.12.0

### Minor Changes

- [#190](https://github.com/pandemicsyn/beachside/pull/190) [`3560e72`](https://github.com/pandemicsyn/beachside/commit/3560e722369b48b64d3a689b784c200e0229f85e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@beachside/archil` adapter for Archil Sandboxes, built on Archil's official `disk` SDK. It creates persistent Firecracker microVMs from OCI images or built image ids in a chosen region, with blocked egress by default (or Archil's managed allowlist on the Free plan), exact sizes and create-time environment variables; runs argv and shell commands with exact output bytes, finite stdin and a truncation bound; streams processes with byte output, piped stdin, signals, status and reopening; opens terminals on Archil's native PTY; reads and writes files of any size with streams, no-clobber writes, copy, move and metadata; pauses and resumes sandboxes with their memory, or stops and cold-boots them; renews the session deadline; captures memory-and-disk or disk-only snapshots as forks of a retained holder sandbox; builds images; manages Archil disks as volumes and mounts them at create; and returns protected previews with a token header or public previews. A create whose response is lost is found again by its name instead of being resent. The CLI gains an `archil` provider that reads `ARCHIL_API_KEY`, `ARCHIL_REGION` and an optional `ARCHIL_NETWORK` (`internet` or `archil-managed`).

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.12.0
