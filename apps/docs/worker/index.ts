import { z } from "zod";

// The docs site is static assets; this worker only answers POST /api/beta-signup and hands every other request to
// the assets. Signups become Resend contacts in the 1.0 beta segment, then a `beta.signed_up` event starts the
// welcome automation (which stays off until it is enabled in Resend).

export type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  // Secrets Store binding (wrangler.jsonc secrets_store_secrets); absent until the store is wired up.
  RESEND_API_KEY?: { get(): Promise<string> };
};

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

async function resend(
  apiKey: string,
  path: string,
  body: ContactCreate | EventSend,
): Promise<Response> {
  return fetch(`${resendApi}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

// A contact that already exists is fine: the person signed up before, so the signup still counts.
async function alreadyExists(response: Response): Promise<boolean> {
  if (response.status === 409) return true;

  const text = await response.text().catch(() => "");

  return /already exists/i.test(text);
}

export async function signUp(env: Env, signup: Signup): Promise<Outcome> {
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

  const event = await resend(apiKey, "/events/send", {
    event: signupEvent,
    email: signup.email,
    payload: { source: signup.source },
  });

  // The contact is saved; a failed welcome trigger should not fail the signup.
  if (!event.ok) console.error("resend event send failed", event.status);

  return { status: 200, body: { ok: true } };
}

export async function handleSignup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return reply({ status: 405, body: { ok: false } });

  const origin = request.headers.get("origin");

  if (origin && !allowedOrigins.has(origin)) return reply({ status: 403, body: { ok: false } });

  const parsed = signupSchema.safeParse(await request.json().catch(() => null));

  if (!parsed.success)
    return reply({
      status: 400,
      body: { ok: false, message: "Please enter a valid email address." },
    });

  // Bots that fill the honeypot get the same answer as people, and nothing is saved.
  if (parsed.data.website) return reply({ status: 200, body: { ok: true } });

  return reply(await signUp(env, parsed.data));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/beta-signup") return handleSignup(request, env);

    return env.ASSETS.fetch(request);
  },
};
