import { upstashBoxAdapter } from "@beachside/upstash-box";
import { Beachside } from "beachside";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { upstashBoxSupport } from "./support";

const Routing = z.strictObject({
  imageId: z.literal("node"),
  networkPolicy: z.literal("internet"),
  nativeLifetimeSeconds: z.literal(900),
});

const defaults = Routing.parse({
  imageId: "node",
  networkPolicy: "internet",
  nativeLifetimeSeconds: 900,
});

export default defineProviderProfile({
  id: "upstash-box",
  nativeVersion: "Upstash Box v2 SDK 0.8.0 reference",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["UPSTASH_BOX_API_KEY"],
  bounds: { nativeLifetimeSeconds: 900, exerciseMs: 120000, cleanupMs: 60000 },
  support: upstashBoxSupport,
  configure(_environment, saved) {
    return Routing.parse(saved ?? defaults);
  },
  configuration(routing) {
    const config = Routing.parse(routing);

    return {
      imageClass: "prepared",
      fileRoot: "/tmp",
      authorityClass: "api-key",
      network: `${config.networkPolicy}-requested`,
      regionClass: "us-east-1",
    };
  },
  connection(routing, credentials) {
    const config = Routing.parse(routing);

    return (onReference, onDiagnostic) =>
      Beachside.connect({
        adapter: upstashBoxAdapter,
        credentials: { apiKey: credentials.UPSTASH_BOX_API_KEY },
        config: {
          image: config.imageId,
          network: config.networkPolicy,
          lifecycle: { lifetimeSeconds: config.nativeLifetimeSeconds },
        },
        onReference,
        onDiagnostic,
      });
  },
});
