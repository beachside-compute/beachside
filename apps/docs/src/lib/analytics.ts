import type { PostHog, PostHogConfig } from "posthog-js";
import project from "./analytics-project.json";

const docsConsentKey = "beachside-docs-analytics-consent-v1";

// Ad pages ask separately: accepting docs analytics never turns on the Reddit Pixel.
const adsConsentKey = "beachside-ads-analytics-consent-v1";

export type Consent = "accepted" | "rejected" | "pending";

// Public ingestion settings belong in the build; overrides support isolated tests.
const key = import.meta.env.PUBLIC_POSTHOG_KEY || project.key;

const host = import.meta.env.PUBLIC_POSTHOG_HOST || project.host;

const persistenceName = "beachside_docs";

// Pages that ask for consent and record analytics: the docs and the ad landing page.
const landingPages = ["/remote"];

export function analyticsPage(pathname: string): boolean {
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return true;

  return landingPages.some((page) => pathname === page || pathname === `${page}/`);
}

// Ad landing pages also load the Reddit Pixel after consent, to measure the Reddit ads.
const redditPixelId = import.meta.env.PUBLIC_REDDIT_PIXEL_ID || project.redditPixelId;

export const redditPixelConfigured = Boolean(redditPixelId);

export function adPage(pathname: string): boolean {
  return (
    Boolean(redditPixelId) &&
    landingPages.some((page) => pathname === page || pathname === `${page}/`)
  );
}

type Rdt = ((...args: unknown[]) => void) & {
  callQueue?: unknown[];
  sendEvent?: (...args: unknown[]) => void;
};

declare global {
  interface Window {
    rdt?: Rdt;
  }
}

let pixelLoaded = false;

function startRedditPixel(): void {
  if (pixelLoaded || !adPage(location.pathname)) return;
  pixelLoaded = true;

  // Reddit's documented base code: queue calls until pixel.js loads, then it replays them.
  // SAFETY: the queue starts empty and only ever holds argument lists pushed below.
  const rdt: Rdt = Object.assign(
    (...args: unknown[]) => {
      if (rdt.sendEvent) rdt.sendEvent(...args);
      else rdt.callQueue?.push(args);
    },
    { callQueue: [] as unknown[] },
  );

  window.rdt = rdt;

  const script = document.createElement("script");

  script.src = "https://www.redditstatic.com/ads/pixel.js";
  script.async = true;
  document.head.append(script);
  rdt("init", redditPixelId);
  rdt("track", "PageVisit");
}

/** Record a conversion: a PostHog event, plus a Reddit Pixel event on ad pages. Does nothing without consent. */
export function trackConversion(
  event: string,
  redditEvent: "SignUp" | "Lead",
  properties: Record<string, string> = {},
): void {
  if (!allowed) return;
  client?.capture(event, properties);

  if (pixelLoaded) window.rdt?.("track", redditEvent);
}

// A named PostHog event for a click worth reporting on its own (not an ad conversion).
export function trackEvent(event: string, properties: Record<string, string> = {}): void {
  if (allowed) client?.capture(event, properties);
}

// Links marked data-track="<event>" report that event when clicked, once consent allows it.
export function trackClicks(page: string): void {
  document.querySelectorAll<HTMLElement>("[data-track]").forEach((link) => {
    link.addEventListener("click", () => trackEvent(link.dataset.track ?? "", { page }));
  });
}

export const analyticsConfigured = Boolean(key && host);

let client: PostHog | undefined;

let starting: Promise<void> | undefined;

let allowed = false;

/** The storage key for this page's consent choice. */
export function consentKey(): string {
  return adPage(location.pathname) ? adsConsentKey : docsConsentKey;
}

export function readConsent(): Consent {
  try {
    const choice = localStorage.getItem(consentKey());

    return choice === "accepted" || choice === "rejected" ? choice : "pending";
  } catch {
    return "pending";
  }
}

export function saveConsent(choice: Exclude<Consent, "pending">): void {
  try {
    localStorage.setItem(consentKey(), choice);
  } catch {
    // Consent still applies to this page; ask again next visit if storage is unavailable.
  }
}

export async function startAnalytics(): Promise<void> {
  if (!key || !host || !analyticsPage(location.pathname)) return;
  allowed = true;
  startRedditPixel();

  if (starting) return starting;
  starting = import("posthog-js")
    .then(({ default: posthog }) => {
      // A rejection while the library loads must win over the earlier acceptance.
      if (!allowed) {
        starting = undefined;

        return;
      }

      const config: Partial<PostHogConfig> = {
        api_host: host,
        ui_host: project.uiHost,
        // No cookieless fallback: pending and rejected visitors send nothing.
        persistence_name: persistenceName,
        cross_subdomain_cookie: false,
        opt_out_capturing_by_default: true,
        opt_out_persistence_by_default: true,
        request_batching: false,
        autocapture: true,
        capture_pageview: true,
        capture_pageleave: true,
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
        disable_session_recording: true,
        enable_recording_console_log: false,
        disable_surveys: true,
        disable_conversations: true,
        disable_product_tours: true,
        before_send: (event) => (allowed ? event : null),
        loaded: (instance) => {
          if (allowed) instance.opt_in_capturing();
        },
      };

      client = posthog.init(key, config, persistenceName);
    })
    .catch(() => {
      starting = undefined;
    });

  return starting;
}

/** Stop capture and remove analytics persistence before reloading an opted-in page. */
export function stopAnalytics(): boolean {
  allowed = false;

  if (client) {
    client.opt_out_capturing();
    client.set_config({ disable_persistence: true, autocapture: false, capture_exceptions: false });
  }

  try {
    // The SDK's persistence toggle leaves its per-tab window ID behind.
    for (const storage of [localStorage, sessionStorage]) {
      for (const name of Object.keys(storage)) {
        if (name.startsWith(`ph_${persistenceName}`)) storage.removeItem(name);
      }
    }
  } catch {
    // Storage can be blocked; capture is already disabled above.
  }

  // The Reddit Pixel can't be unloaded; drop its first-party cookie and let the caller reload.
  // The site is served only over HTTPS, so the deletion is marked Secure like the cookie itself.
  for (const domain of ["", `; domain=${location.hostname}`, `; domain=.${location.hostname}`])
    document.cookie = `_rdt_uuid=; Max-Age=0; path=/; Secure; SameSite=Lax${domain}`;

  return Boolean(client) || pixelLoaded;
}
