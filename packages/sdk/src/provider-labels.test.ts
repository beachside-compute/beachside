import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FIRST_PARTY_PROVIDERS, providerLabel } from "./provider-labels";

const providersDir = join(import.meta.dir, "../../providers");

const Definition = z.object({
  name: z.string(),
  connect: z.custom<() => Promise<object>>((value) => value instanceof Function),
});

async function declaredNames(dir: string): Promise<string[]> {
  const module = await import(join(providersDir, dir, "src/index.ts"));

  const names = Object.values(module).flatMap((value) => {
    const parsed = Definition.safeParse(value);

    return parsed.success ? [parsed.data.name] : [];
  });

  // The private fake provider only exports a factory that needs a server address.
  if (module.createFakeAdapter instanceof Function) {
    const created = Definition.safeParse(
      module.createFakeAdapter({ url: "http://127.0.0.1:1", token: "t" }),
    );

    if (created.success) names.push(created.data.name);
  }

  return [...new Set(names)];
}

test("every first-party provider package has a telemetry label, and no label is stale", async () => {
  const dirs = (await readdir(providersDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const declared = new Set<string>();

  for (const dir of dirs) {
    const names = await declaredNames(dir);

    expect(names, `packages/providers/${dir} exports no adapter definition`).not.toEqual([]);

    for (const name of names) {
      declared.add(name);

      expect(
        FIRST_PARTY_PROVIDERS.has(name),
        `Adapter "${name}" from packages/providers/${dir} is missing from FIRST_PARTY_PROVIDERS in packages/sdk/src/provider-labels.ts, so its telemetry would say "custom".`,
      ).toBe(true);
    }
  }

  for (const label of FIRST_PARTY_PROVIDERS)
    expect(declared.has(label), `FIRST_PARTY_PROVIDERS lists "${label}" with no package`).toBe(
      true,
    );
});

test("application-defined adapters keep the bounded custom label", () => {
  expect(providerLabel("boxd")).toBe("boxd");
  expect(providerLabel("acme.internal")).toBe("custom");
});
