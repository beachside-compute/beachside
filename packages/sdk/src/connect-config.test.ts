import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter } from "@beachside/adapter";
import { Beachside } from "./index";

function adapter<C extends z.ZodType>(config: C) {
  return defineAdapter({
    name: "example.config",
    config,
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope: { authority: { kind: "account", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        async create() {
          return { id: "box", state: "running" as const };
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });
}

test("config can be left out when every field is optional", async () => {
  const client = await Beachside.connect({
    adapter: adapter(z.strictObject({ region: z.string().optional() })),
    credentials: {},
  });

  await client.close();
});

test("a required config field stays required and is named when missing", async () => {
  const required = adapter(z.strictObject({ target: z.string() }));

  // @ts-expect-error `config` is required when the adapter has a required field.
  const pending = Beachside.connect({ adapter: required, credentials: {} });

  await expect(pending).rejects.toThrow("Invalid configuration: target");
});
