import { upstashBoxAdapter } from "@beachside/upstash-box";
import { Beachside } from "beachside";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { upstashBoxSupport } from "./support";

const Routing = z.strictObject({
  imageId: z.enum(["node", "python", "python-alpine"]),
  networkPolicy: z.enum(["internet", "allow"]),
  nativeLifetimeSeconds: z.literal(900),
  boxKind: z.enum(["ephemeral", "regular"]).default("ephemeral"),
  previewAccess: z.enum(["protected", "public"]).optional(),
});

export default defineProviderProfile({
  id: "upstash-box",
  nativeVersion: "Upstash Box v2 SDK 0.8.0 reference",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["UPSTASH_BOX_API_KEY"],
  bounds: { nativeLifetimeSeconds: 900, exerciseMs: 240000, cleanupMs: 60000 },
  support: upstashBoxSupport,
  configure(environment, saved) {
    return Routing.parse(
      saved ?? {
        imageId: environment.BEACHSIDE_UPSTASH_IMAGE ?? "node",
        networkPolicy: environment.BEACHSIDE_UPSTASH_NETWORK ?? "internet",
        nativeLifetimeSeconds: 900,
        boxKind: environment.BEACHSIDE_UPSTASH_BOX_KIND,
        ...(environment.BEACHSIDE_UPSTASH_PREVIEW && {
          previewAccess: environment.BEACHSIDE_UPSTASH_PREVIEW,
        }),
      },
    );
  },
  configuration(routing) {
    const config = Routing.parse(routing);

    return {
      imageClass: "prepared",
      imageVariant: config.imageId,
      sandboxVariant: config.boxKind,
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
          boxKind: config.boxKind,
          network: config.networkPolicy === "allow" ? { allow: ["example.com"] } : "internet",
          ...(config.boxKind === "ephemeral" && {
            lifecycle: { lifetimeSeconds: config.nativeLifetimeSeconds },
          }),
          ...(config.previewAccess && { preview: { access: config.previewAccess } }),
        },
        onReference,
        onDiagnostic,
      });
  },
});
