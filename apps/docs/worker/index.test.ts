import { afterEach, describe, expect, test } from "bun:test";

import worker, { type Env } from "./index";

const realFetch = globalThis.fetch;

const assets: Env["ASSETS"] = { fetch: async () => new Response("asset") };

type SignupBody = { email: string; source: string; website?: string };

function post(body: SignupBody, origin = "https://beachside.run"): Request {
  return new Request("https://beachside.run/api/beta-signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

function stubResend(contactStatus: number, contactBody = "{}") {
  const calls: { url: string; body: string }[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      calls.push({ url, body: String(init?.body) });

      if (url.endsWith("/contacts")) return new Response(contactBody, { status: contactStatus });

      return new Response("{}", { status: 202 });
    },
    { preconnect() {} },
  );

  globalThis.fetch = fetcher;

  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("beta signup worker", () => {
  test("serves assets for other paths", async () => {
    const response = await worker.fetch(new Request("https://beachside.run/beta/"), {
      ASSETS: assets,
    });

    expect(await response.text()).toBe("asset");
  });

  test("saves the contact in the beta segment and sends the signup event", async () => {
    const calls = stubResend(200);

    const response = await worker.fetch(
      post({ email: "a@example.com", source: "beachside.run/beta reddit rex" }),
      {
        ASSETS: assets,
        RESEND_API_KEY: "re_test",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.resend.com/contacts",
      "https://api.resend.com/events/send",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      email: "a@example.com",
      segments: [{ id: "6f4eb137-076b-4d92-a8a6-8120d59d91a1" }],
      properties: { signup_source: "beachside.run/beta reddit rex" },
    });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toMatchObject({
      event: "beta.signed_up",
      email: "a@example.com",
    });
  });

  test("treats an existing contact as a signup", async () => {
    stubResend(409, '{"message":"Contact already exists"}');

    const response = await worker.fetch(post({ email: "a@example.com", source: "x" }), {
      ASSETS: assets,
      RESEND_API_KEY: "re_test",
    });

    expect(response.status).toBe(200);
  });

  test("rejects bad email, foreign origins and missing keys", async () => {
    const calls = stubResend(200);

    const env = { ASSETS: assets, RESEND_API_KEY: "re_test" };

    expect((await worker.fetch(post({ email: "nope", source: "x" }), env)).status).toBe(400);
    expect(
      (
        await worker.fetch(
          post({ email: "a@example.com", source: "x" }, "https://evil.example"),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (await worker.fetch(post({ email: "a@example.com", source: "x" }), { ASSETS: assets }))
        .status,
    ).toBe(503);
    expect(calls).toEqual([]);
  });

  test("honeypot submissions get a quiet success and save nothing", async () => {
    const calls = stubResend(200);

    const response = await worker.fetch(
      post({ email: "a@example.com", source: "x", website: "spam" }),
      {
        ASSETS: assets,
        RESEND_API_KEY: "re_test",
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
