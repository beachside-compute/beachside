---
title: Upstash Box
description: Use Upstash Box ephemeral or regular sandboxes with Beachside.
---

Install `beachside` and `@beachside/upstash-box`, then get a write-capable Box API key from the [Upstash Console](https://console.upstash.com/). Use `UPSTASH_BOX_API_KEY` for the CLI profile or supply it as `credentials.apiKey` when connecting with `upstashBoxAdapter`. The `upstashBox({ apiKey, ...config })` factory combines the two setup arguments.

```ts
import { Beachside } from "beachside";
import { upstashBoxAdapter } from "@beachside/upstash-box";

const client = await Beachside.connect({
  adapter: upstashBoxAdapter,
  config: {},
  credentials: { apiKey: process.env.UPSTASH_BOX_API_KEY! },
});
try {
  const box = await client.sandboxes.create();
  try {
    await box.writeFile("/workspace/home/input.bin", Uint8Array.of(0, 255));
    const result = await box.exec(["node", "--version"]);
    console.log(result.stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

## Box kinds and setup

Beachside defaults to `boxKind: "ephemeral"` in AWS us-east-1. Ephemeral boxes use a native TTL of 900 seconds by default. Set `lifecycle.lifetimeSeconds` to request a positive whole number of seconds, up to Upstash's 259,200-second maximum.

Set `boxKind: "regular"` for HTTP previews and explicit pause and resume. Regular boxes have no automatic deletion deadline. The adapter rejects a configured TTL for regular boxes before allocation. With `keepAlive: true`, Upstash keeps regular compute active on an eligible paid plan and disables pause and resume.

Select a prepared `image` from `node`, `python`, `golang`, `ruby`, `rust` and their `-alpine` variants. The default is Debian `node`. Set `resources` to select the smallest Upstash size that meets your CPU and memory requirements. The default is small (2 vCPUs, 4 GiB). Your account controls size availability.

Both kinds accept create-time env. Upstash reserves system variables such as `PATH`, `HOME` and `NODE_OPTIONS`. The adapter rejects those names. Network defaults to `"internet"`. Configure an allowlist with `network: { allow: ["api.example.com"] }`. Custom policy can still resolve unlisted names over DNS. Upstash blocks private ranges. In live testing, native `deny-all` still allowed the outbound TCP probes. See the [native matching rules](https://upstash.com/docs/box/overall/network-policy#matching-rules).

## Commands, files and previews

- Finite exec accepts argv or shell commands and per-command env. It captures up to 1 MiB of combined output and accepts up to 1 MiB of binary stdin. Live processes also support incremental stdin, separate output, signals and PTYs. Upstash ends the native session when its socket closes.
- File reads use bounded native ranges. The file hooks expose streaming writes, directory operations, metadata, copy and overwrite moves. A default no-clobber write stages bytes and publishes the file exclusively. The destination filesystem must support hard links, and the runtime must provide `ln -T` for exact-path publication. This flag is available in GNU coreutils and current Alpine BusyBox. Upstash's rename endpoint supports overwrite moves.
- Regular previews default to protected access. Set `preview: { access: "public" }` for an unauthenticated HTTPS route. A public lookup reuses an existing public route. Requesting a protected route again rotates its bearer token and invalidates previously returned headers for that port. The adapter rejects a different access mode in the observed route and requires a running box at the readiness check. Upstash can resume a paused box on traffic to an existing route or if the box pauses during publication.
- Up to four user labels fit alongside a correlation marker. Each encoded `key:value` must fit Upstash's 20-character limit and use letters, digits, periods, underscores, colons or hyphens. Colons in keys and the reserved `bs:` prefix are unsupported.

## Recovery and snapshots

Saved Beachside references reopen the exact Box ID with a currently authorized key. Inventory lists boxes visible to the key. Entries with evidence of the selected class have borrowed references. An uncertain mutation is observed without replay.

Upstash snapshots capture filesystem state for a fresh box. Restore selects the configured box kind and reapplies the configured network policy. Snapshot artifacts can survive source deletion. The Box API key supports source-scoped snapshot lookup. Restore uses the saved snapshot ID and requires that lookup to confirm readiness. A successfully restored Box has its own lifecycle. Deletion uses the saved ID directly.

The adapter is experimental. In us-east-1, live tests covered the ephemeral Debian baseline, Alpine file and directory operations, Debian process streaming, a custom HTTPS allowlist and snapshot restore after source deletion. See [tested provider support](/docs/providers/support/).
