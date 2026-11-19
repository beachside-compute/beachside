# @beachside/upstash-box

Experimental Beachside adapter for ephemeral and regular Upstash Box sandboxes in AWS us-east-1. Live results cover the ephemeral Debian baseline, Alpine files and directories, process streaming, custom HTTPS allowlist and snapshot restore. See the [provider support matrix](https://beachside.run/docs/providers/support/).

```sh
npm install beachside @beachside/upstash-box
```

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
    const result = await box.exec(["node", "--version"]);
    console.log(result.stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

See the [provider guide](https://beachside.run/docs/providers/upstash-box/) for defaults, bounds and recovery.
