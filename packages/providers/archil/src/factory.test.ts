import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { archil, archilAdapter, createArchilAdapter } from "./index";

test("archil() binds the same definition the split form uses", () => {
  const bound = archil({ apiKey: "key", region: "aws-us-east-1" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(archilAdapter.name);
});

test("archil() validates credentials and region at connect, before any provider call", async () => {
  await expect(
    Beachside.connect(archil({ apiKey: "", region: "aws-us-east-1" })),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error -- a storage-only region has no sandboxes.
    Beachside.connect(archil({ apiKey: "key", region: "gcp-us-central1" })),
  ).rejects.toThrow();
});

test("the region defaults to aws-us-east-1, and a refused key points at the region", async () => {
  const seen: string[] = [];
  const adapter = createArchilAdapter({
    fetch: async (input) => {
      seen.push(String(input));

      return Response.json(
        { error: { code: "unauthorized", message: "Invalid API key" } },
        { status: 401 },
      );
    },
  });

  await expect(
    Beachside.connect({ adapter, credentials: { apiKey: "key" }, config: {} }),
  ).rejects.toThrow(/works only in its own region/);
  expect(seen[0]).toStartWith("https://control.green.us-east-1.aws.prod.archil.com/");
});
