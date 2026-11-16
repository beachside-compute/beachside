import { Beachside, Image } from "beachside";
import { boxdAdapter } from "@beachside/boxd";
import { daytonaAdapter } from "@beachside/daytona";
import { e2bAdapter } from "@beachside/e2b";
import { freestyleAdapter } from "@beachside/freestyle";
import { runloopAdapter } from "@beachside/runloop";
import { vercelAdapter } from "@beachside/vercel";

export const PROVIDERS = ["daytona", "e2b", "boxd", "freestyle", "vercel", "runloop"] as const;

export type Provider = (typeof PROVIDERS)[number];

// The OpenCode server's port; providers that publish only listed ports must include it.
export const PORT = 4096;

export function isProvider(name: string | undefined): name is Provider {
  return PROVIDERS.some((provider) => provider === name);
}

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) throw new Error(`Set ${name} in examples/.env.local`);

  return value;
}

function optional(name: string) {
  return process.env[name]?.trim() || undefined;
}

/**
 * Connect to a provider for a box. Every box needs internet egress (the OpenCode download and
 * the model API) and a preview route to the server's port. Only this function differs per
 * provider; the box commands are the same everywhere.
 */
export function connectBox(provider: Provider, lifetimeSeconds: number) {
  const lifecycle = { lifetimeSeconds };

  switch (provider) {
    case "daytona":
      return Beachside.connect({
        adapter: daytonaAdapter,
        credentials: { apiKey: required("DAYTONA_API_KEY") },
        config: {
          target: required("DAYTONA_TARGET"),
          environment: Image.prepared(required("DAYTONA_SNAPSHOT")),
          lifecycle,
          network: "daytona-default",
        },
      });
    case "e2b":
      return Beachside.connect({
        adapter: e2bAdapter,
        credentials: { apiKey: required("E2B_API_KEY") },
        config: {
          templateId: optional("E2B_TEMPLATE_ID") ?? "base",
          lifecycle,
          network: "internet",
        },
      });
    case "boxd":
      return Beachside.connect({
        adapter: boxdAdapter,
        credentials: { apiKey: required("BOXD_API_KEY") },
        config: {
          org: required("BOXD_ORG"),
          region: optional("BOXD_REGION"),
          lifecycle,
          network: "internet",
          preview: { access: "public", ports: [PORT] },
        },
      });
    case "freestyle":
      return Beachside.connect({
        adapter: freestyleAdapter,
        credentials: { apiKey: required("FREESTYLE_API_KEY") },
        config: { lifecycle, network: "internet", preview: { ports: [PORT] } },
      });
    case "vercel":
      return Beachside.connect({
        adapter: vercelAdapter,
        credentials: { token: required("VERCEL_TOKEN") },
        config: {
          teamId: required("VERCEL_TEAM_ID"),
          projectId: required("VERCEL_PROJECT_ID"),
          lifecycle,
          network: "internet",
          ports: [PORT],
        },
      });
    case "runloop":
      return Beachside.connect({
        adapter: runloopAdapter,
        credentials: { apiKey: required("RUNLOOP_API_KEY") },
        config: { lifecycle, network: "internet" },
      });
  }
}
