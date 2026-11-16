import { z } from "zod";

import project from "../src/lib/analytics-project.json";

// The docs site is static assets; this worker only answers POST /api/beta-signup and hands every other request to
// the assets. Signups become Resend contacts in the 1.0 beta segment, then a `beta.signed_up` event starts the
// welcome automation (which stays off until it is enabled in Resend). A new signup is also reported to Reddit's
// Conversions API, so ad conversions count for visitors who never answered the consent banner.

export type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  // Secrets Store binding (wrangler.jsonc secrets_store_secrets); absent until the store is wired up.
  RESEND_API_KEY?: { get(): Promise<string> };
  // Rate limiting binding (wrangler.jsonc ratelimits), keyed by client IP.
  SIGNUP_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  // Secrets Store binding for the Reddit Conversions API access token; without it nothing is sent to Reddit.
  REDDIT_CONVERSIONS_TOKEN?: { get(): Promise<string> };
  // A test ID from Reddit Events Manager > Event Testing sends events there instead of to production.
  REDDIT_TEST_ID?: string;
};

export type Context = { waitUntil(promise: Promise<unknown>): void };

const resendApi = "https://api.resend.com";

// Resend segment "Beachside 1.0 beta".
const betaSegment = "6f4eb137-076b-4d92-a8a6-8120d59d91a1";

const signupEvent = "beta.signed_up";

const allowedOrigins = new Set([
  "https://beachside.run",
  "https://www.beachside.run",
  "https://beachside.sh",
  "https://www.beachside.sh",
  "https://sandbarsdk.dev",
  "https://www.sandbarsdk.dev",
  "http://localhost:4321",
]);

const signupSchema = z.object({
  email: z.email().max(320),
  source: z
    .string()
    .max(200)
    .transform((value) => value.replace(/[^\w ./:-]/g, "").trim() || "beachside.run/beta"),
  // Honeypot: a hidden field people never fill in.
  website: z.string().max(200).optional(),
  // Ad attribution, all optional. The page and the Reddit Pixel share conversionId, so Reddit counts the signup once.
  conversionId: z
    .string()
    .regex(/^[\w-]{8,64}$/)
    .optional()
    .catch(undefined),
  // Reddit's click ID, from the ad link's rdt_cid parameter.
  clickId: z
    .string()
    .regex(/^[\w.~-]{1,512}$/)
    .optional()
    .catch(undefined),
  // The Reddit Pixel's _rdt_uuid cookie, present only after the visitor accepted the banner.
  redditUuid: z
    .string()
    .regex(/^[\w.-]{1,128}$/)
    .optional()
    .catch(undefined),
  // The page address with its query (rdt_cid and UTMs), reported as the event source.
  page: z.url().max(2048).optional().catch(undefined),
  // The banner choice. A visitor who declined is never reported to Reddit.
  consent: z.enum(["accepted", "rejected", "pending"]).optional().catch(undefined),
});

export type Signup = z.infer<typeof signupSchema>;

type Outcome = { status: number; body: { ok: boolean; message?: string } };

function reply({ status, body }: Outcome): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

type ContactCreate = {
  email: string;
  unsubscribed: boolean;
  segments: { id: string }[];
  properties: { signup_source: string };
};

type EventSend = { event: string; email: string; payload: { source: string } };

// A network failure reads as a 503 from Resend, so callers handle one kind of failure.
async function resend(
  apiKey: string,
  path: string,
  body: ContactCreate | EventSend,
): Promise<Response> {
  try {
    return await fetch(`${resendApi}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error("resend request failed", path, error instanceof Error ? error.message : error);

    return new Response(null, { status: 503 });
  }
}

// A contact that already exists is fine: the person signed up before, so the signup still counts.
async function alreadyExists(response: Response): Promise<boolean> {
  if (response.status === 409) return true;

  const text = await response.text().catch(() => "");

  return /already exists/i.test(text);
}

export type Visitor = { ip?: string; userAgent?: string };

export async function signUp(
  env: Env,
  signup: Signup,
  report: (signup: Signup) => void = () => {},
): Promise<Outcome> {
  const apiKey = await env.RESEND_API_KEY?.get().catch(() => "");

  if (!apiKey)
    return {
      status: 503,
      body: { ok: false, message: "Signups are not open yet. Please try again later." },
    };

  const contact = await resend(apiKey, "/contacts", {
    email: signup.email,
    unsubscribed: false,
    segments: [{ id: betaSegment }],
    properties: { signup_source: signup.source },
  });

  if (!contact.ok && !(await alreadyExists(contact))) {
    console.error("resend contact create failed", contact.status);

    return { status: 502, body: { ok: false, message: "Something went wrong. Please try again." } };
  }

  // Only a new contact is a new conversion; signing up again is not.
  if (contact.ok) report(signup);

  const event = await resend(apiKey, "/events/send", {
    event: signupEvent,
    email: signup.email,
    payload: { source: signup.source },
  });

  // The contact is saved; a failed welcome trigger should not fail the signup.
  if (!event.ok) console.error("resend event send failed", event.status);

  return { status: 200, body: { ok: true } };
}

const redditApi = "https://ads-api.reddit.com/api/v3/pixels";

// Reddit's email rule: lowercase, then drop dots and any +suffix from the local part, then SHA-256 as 64 hex digits.
export async function hashEmail(email: string): Promise<string> {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  const canonical = `${local.split("+")[0]?.replaceAll(".", "") ?? ""}@${domain}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Keep only page addresses on this site, so the event never names another domain.
function sourceUrl(page: string | undefined): string | undefined {
  if (!page) return undefined;

  return allowedOrigins.has(new URL(page).origin) ? page : undefined;
}

type ConversionEvent = {
  event_at: number;
  action_source: "WEBSITE";
  type: { tracking_type: "SIGN_UP" };
  event_source_url?: string;
  click_id?: string;
  user: { email: string; ip_address?: string; user_agent?: string; uuid?: string };
  metadata: { conversion_id: string };
};

export async function redditConversion(
  signup: Signup,
  visitor: Visitor,
  now = Date.now(),
): Promise<ConversionEvent> {
  return {
    event_at: now,
    action_source: "WEBSITE",
    type: { tracking_type: "SIGN_UP" },
    event_source_url: sourceUrl(signup.page),
    click_id: signup.clickId,
    user: {
      email: await hashEmail(signup.email),
      ip_address: visitor.ip,
      user_agent: visitor.userAgent,
      uuid: signup.redditUuid,
    },
    metadata: { conversion_id: signup.conversionId ?? crypto.randomUUID() },
  };
}

// Best effort: a missing token, a declined banner or a Reddit failure never changes the signup's answer.
export async function reportToReddit(env: Env, signup: Signup, visitor: Visitor): Promise<void> {
  if (signup.consent === "rejected") return;

  try {
    const token = await env.REDDIT_CONVERSIONS_TOKEN?.get().catch(() => "");

    if (!token) return;

    const event = await redditConversion(signup, visitor);

    const data = env.REDDIT_TEST_ID
      ? { test_id: env.REDDIT_TEST_ID, events: [event] }
      : { events: [event] };

    const response = await fetch(`${redditApi}/${project.redditPixelId}/conversion_events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });

    if (!response.ok)
      console.error(
        "reddit conversion failed",
        response.status,
        (await response.text().catch(() => "")).slice(0, 300),
      );
  } catch (error) {
    console.error("reddit conversion failed", error instanceof Error ? error.message : error);
  }
}

export async function handleSignup(
  request: Request,
  env: Env,
  context?: Context,
): Promise<Response> {
  if (request.method !== "POST") return reply({ status: 405, body: { ok: false } });

  // Browsers always send Origin on a form POST, so a missing one is not a person on the site.
  const origin = request.headers.get("origin");

  if (!origin || !allowedOrigins.has(origin)) return reply({ status: 403, body: { ok: false } });

  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const allowed = (await env.SIGNUP_LIMITER?.limit({ key: client }))?.success ?? true;

  if (!allowed)
    return reply({
      status: 429,
      body: { ok: false, message: "Too many tries. Please wait a minute and try again." },
    });

  const parsed = signupSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success)
    return reply({
      status: 400,
      body: { ok: false, message: "Please enter a valid email address." },
    });

  // Bots that fill the honeypot get the same answer as people, and nothing is saved.
  if (parsed.data.website) return reply({ status: 200, body: { ok: true } });

  const visitor: Visitor = {
    ip: request.headers.get("cf-connecting-ip") ?? undefined,
    userAgent: request.headers.get("user-agent")?.slice(0, 512) ?? undefined,
  };

  // The Reddit call runs after the answer is sent when the runtime allows it.
  const pending: Promise<void>[] = [];

  const outcome = await signUp(env, parsed.data, (signup) => {
    const sent = reportToReddit(env, signup, visitor);

    if (context) context.waitUntil(sent);
    else pending.push(sent);
  });

  await Promise.all(pending);

  return reply(outcome);
}

export default {
  async fetch(request: Request, env: Env, context?: Context): Promise<Response> {
    if (new URL(request.url).pathname === "/api/beta-signup")
      return handleSignup(request, env, context);

    return env.ASSETS.fetch(request);
  },
};
