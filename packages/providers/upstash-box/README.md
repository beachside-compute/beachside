# @beachside/upstash-box

Beachside adapter for Upstash Box ephemeral sandboxes in AWS us-east-1. The implementation has local fixture coverage. Live qualification is pending.

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
