import { afterEach, describe, expect, test } from "bun:test";

import worker, { type Env, hashEmail } from "./index";

const realFetch = globalThis.fetch;

const testKey: Env["RESEND_API_KEY"] = { get: async () => "re_test" };

const assets: Env["ASSETS"] = { fetch: async () => new Response("asset") };

type SignupBody = {
  email: string;
  source: string;
  website?: string;
  conversionId?: string;
  clickId?: string;
  redditUuid?: string;
  page?: string;
  consent?: string;
};

const redditToken: Env["REDDIT_CONVERSIONS_TOKEN"] = { get: async () => "reddit_test" };

const attributed: SignupBody = {
  email: "Al.ice+Apple@Example.Com",
  source: "beachside.run/beta reddit bt1",
  conversionId: "3f2a6c1e-8d4b-4f7a-9c1d-2b3e4f5a6b7c",
  clickId: "click123",
  page: "https://beachside.run/beta/?utm_source=reddit&utm_campaign=bt1&rdt_cid=click123",
  consent: "pending",
};

function post(body: SignupBody, origin = "https://beachside.run"): Request {
  return new Request("https://beachside.run/api/beta-signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

function stubResend(
  contactStatus: number,
  contactBody = "{}",
  redditStatus = 200,
  redditBody = "{}",
) {
  const calls: { url: string; body: string }[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      calls.push({ url, body: String(init?.body) });

      if (url.endsWith("/contacts")) return new Response(contactBody, { status: contactStatus });

      if (url.includes("ads-api.reddit.com"))
        return new Response(redditBody, { status: redditStatus });

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
        RESEND_API_KEY: testKey,
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
      RESEND_API_KEY: testKey,
    });

    expect(response.status).toBe(200);
  });

  test("rejects bad email, foreign origins and missing keys", async () => {
    const calls = stubResend(200);

    const env = { ASSETS: assets, RESEND_API_KEY: testKey };

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

  test("rejects requests without an Origin header", async () => {
    const calls = stubResend(200);

    const request = new Request("https://beachside.run/api/beta-signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com", source: "x" }),
    });

    const response = await worker.fetch(request, { ASSETS: assets, RESEND_API_KEY: testKey });

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  test("answers 429 when the client is over its rate limit", async () => {
    const calls = stubResend(200);
    const keys: string[] = [];

    const limiter: Env["SIGNUP_LIMITER"] = {
      limit: async ({ key }) => {
        keys.push(key);

        return { success: false };
      },
    };

    const request = post({ email: "a@example.com", source: "x" });

    request.headers.set("cf-connecting-ip", "203.0.113.7");

    const response = await worker.fetch(request, {
      ASSETS: assets,
      RESEND_API_KEY: testKey,
      SIGNUP_LIMITER: limiter,
    });

    expect(response.status).toBe(429);
    expect(keys).toEqual(["203.0.113.7"]);
    expect(calls).toEqual([]);
  });

  test("a Resend network failure answers 502, and a failed event still saves the signup", async () => {
    const env = { ASSETS: assets, RESEND_API_KEY: testKey };

    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("network down");
      },
      { preconnect() {} },
    );

    const failed = await worker.fetch(post({ email: "a@example.com", source: "x" }), env);

    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false });

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/contacts")) return new Response("{}", { status: 200 });

        throw new TypeError("network down");
      },
      { preconnect() {} },
    );

    expect((await worker.fetch(post({ email: "a@example.com", source: "x" }), env)).status).toBe(
      200,
    );
  });

  test("hashes email the way Reddit's Conversions API asks", async () => {
    expect(await hashEmail("Al.ice+Apple@Example.Com")).toBe(
      "ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976",
    );
  });

  test("reports a new signup to Reddit with the click ID, page and shared conversion ID", async () => {
    const calls = stubResend(200);

    const request = post(attributed);

    request.headers.set("cf-connecting-ip", "203.0.113.7");
    request.headers.set("user-agent", "Mozilla/5.0 test");

    const response = await worker.fetch(request, {
      ASSETS: assets,
      RESEND_API_KEY: testKey,
      REDDIT_CONVERSIONS_TOKEN: redditToken,
    });

    expect(response.status).toBe(200);

    const reddit = calls.find((call) => call.url.includes("ads-api.reddit.com"));

    expect(reddit?.url).toBe(
      "https://ads-api.reddit.com/api/v3/pixels/p2_16reu4htfhrxg/conversion_events",
    );

    const body = JSON.parse(reddit?.body ?? "{}");

    expect(body.data.test_id).toBeUndefined();
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0]).toMatchObject({
      action_source: "WEBSITE",
      type: { tracking_type: "SIGN_UP" },
      click_id: "click123",
      event_source_url: attributed.page,
      user: {
        email: "ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976",
        ip_address: "203.0.113.7",
        user_agent: "Mozilla/5.0 test",
      },
      metadata: { conversion_id: attributed.conversionId },
    });
    expect(body.data.events[0].event_at).toBeGreaterThan(1_700_000_000_000);
    expect(reddit?.body).not.toContain("Example.Com");
  });

  test("sends to Reddit Event Testing when a test ID is set", async () => {
    const calls = stubResend(200);

    await worker.fetch(post(attributed), {
      ASSETS: assets,
      RESEND_API_KEY: testKey,
      REDDIT_CONVERSIONS_TOKEN: redditToken,
      REDDIT_TEST_ID: "t2_test",
    });

    const reddit = calls.find((call) => call.url.includes("ads-api.reddit.com"));

    expect(JSON.parse(reddit?.body ?? "{}").data.test_id).toBe("t2_test");
  });

  test("skips Reddit without a token, after a declined banner, and for a repeat signup", async () => {
    const env = { ASSETS: assets, RESEND_API_KEY: testKey, REDDIT_CONVERSIONS_TOKEN: redditToken };

    const reddit = (calls: { url: string }[]) =>
      calls.filter((call) => call.url.includes("ads-api.reddit.com"));

    let calls = stubResend(200);

    await worker.fetch(post(attributed), { ASSETS: assets, RESEND_API_KEY: testKey });
    expect(reddit(calls)).toEqual([]);

    calls = stubResend(200);
    await worker.fetch(post({ ...attributed, consent: "rejected" }), env);
    expect(reddit(calls)).toEqual([]);

    calls = stubResend(409, '{"message":"Contact already exists"}');
    await worker.fetch(post(attributed), env);
    expect(reddit(calls)).toEqual([]);
  });

  test("drops page addresses from other sites and malformed attribution fields", async () => {
    const calls = stubResend(200);

    const response = await worker.fetch(
      post({
        ...attributed,
        page: "https://evil.example/?rdt_cid=x",
        clickId: "bad id <script>",
        conversionId: "x",
      }),
      { ASSETS: assets, RESEND_API_KEY: testKey, REDDIT_CONVERSIONS_TOKEN: redditToken },
    );

    expect(response.status).toBe(200);

    const event = JSON.parse(
      calls.find((call) => call.url.includes("ads-api.reddit.com"))?.body ?? "{}",
    ).data.events[0];

    expect(event.event_source_url).toBeUndefined();
    expect(event.click_id).toBeUndefined();
    expect(event.metadata.conversion_id).toMatch(/^[\w-]{36}$/);
  });

  test("a Reddit failure never fails the signup", async () => {
    stubResend(200, "{}", 500, "boom");

    const env = { ASSETS: assets, RESEND_API_KEY: testKey, REDDIT_CONVERSIONS_TOKEN: redditToken };

    expect((await worker.fetch(post(attributed), env)).status).toBe(200);

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input).includes("ads-api.reddit.com")) throw new TypeError("network down");

        return new Response("{}", { status: 200 });
      },
      { preconnect() {} },
    );

    expect((await worker.fetch(post(attributed), env)).status).toBe(200);

    const broken: Env["REDDIT_CONVERSIONS_TOKEN"] = {
      get: async () => {
        throw new Error("secret missing");
      },
    };

    expect(
      (
        await worker.fetch(post(attributed), {
          ASSETS: assets,
          RESEND_API_KEY: testKey,
          REDDIT_CONVERSIONS_TOKEN: broken,
        })
      ).status,
    ).toBe(200);
  });

  test("honeypot submissions get a quiet success and save nothing", async () => {
    const calls = stubResend(200);

    const response = await worker.fetch(
      post({ email: "a@example.com", source: "x", website: "spam" }),
      {
        ASSETS: assets,
        RESEND_API_KEY: testKey,
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });
});
