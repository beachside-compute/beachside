import { describe, expect, test } from "bun:test";

import worker, { type Env } from "./index";

const assets: Env["ASSETS"] = { fetch: async () => new Response("asset") };

const get = (url: string) => worker.fetch(new Request(url), { ASSETS: assets });

describe("docs worker", () => {
  test("serves assets for other paths", async () => {
    for (const path of ["/", "/docs/", "/remote/", "/beta-other", "/betas/", "/beta/x"]) {
      const response = await get(`https://beachside.run${path}`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("asset");
    }
  });

  for (const path of ["/beta", "/beta/"]) {
    test(`redirects ${path} to the beta page on beachsidecompute.com`, async () => {
      const response = await get(`https://beachside.run${path}`);

      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("https://beachsidecompute.com/beta/");
    });

    test(`keeps the query string when redirecting ${path}`, async () => {
      const response = await get(
        `https://www.beachside.sh${path}?utm_source=reddit&utm_campaign=rex%20launch`,
      );

      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(
        "https://beachsidecompute.com/beta/?utm_source=reddit&utm_campaign=rex%20launch",
      );
    });
  }
});
