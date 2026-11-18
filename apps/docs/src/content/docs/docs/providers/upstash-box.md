---
title: Upstash Box
description: Run finite commands and work with files in ephemeral Upstash Box sandboxes.
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

## Defaults and limits

- Boxes use the Debian `node` prepared runtime in AWS us-east-1. Set `resources` to select the smallest Upstash size that meets your CPU and memory requirements. The default is small (2 vCPUs, 4 GiB). Your Upstash plan controls size availability.
- `lifecycle.lifetimeSeconds` defaults to 900. The adapter accepts 300 to 259,200 seconds. Upstash deletes boxes when their TTL expires.
- Network defaults to `"internet"`. Set `network: "blocked"` or configure an allowlist with `network: { allow: ["api.example.com"] }`. Upstash blocks private ranges. An unlisted domain may still resolve over DNS in custom mode. The wildcard `*.example.com` excludes the apex. See the [native matching rules](https://upstash.com/docs/box/overall/network-policy#matching-rules).
- Finite exec accepts argv or shell commands and per-command env. It captures up to 1 MiB of combined output and accepts up to 1 MiB of binary stdin. Live sessions require a write-capable key. Read-only keys can inspect boxes and read files on an awake box.
- File reads use bounded ranges and support larger files through Beachside's file streams. File writes are bounded to 1 MiB. The default write creates the path exclusively. Pass `overwrite: true` to replace a file.
- Up to four user labels fit alongside the adapter's correlation marker. Each encoded `key:value` must fit Upstash's 20-character limit and use letters, digits, periods, underscores, colons or hyphens. Colons in keys and the reserved `bs:` prefix are unsupported.
- The adapter covers ephemeral lifecycle, finite exec and files. Create-time env, OCI images, retained storage, snapshots, previews, remote inventory and interactive processes are outside this integration.

## Reopening and cleanup

Save the full Beachside reference after create. A fresh client can reopen the exact Box ID with a currently authorized key. Unknown create and delete outcomes are never replayed automatically. A confirmed Box ID remains available for follow-up if provisioning could not be confirmed. A delete acknowledgment followed by an inconclusive read leaves cleanup unconfirmed.

Live qualification is pending.
