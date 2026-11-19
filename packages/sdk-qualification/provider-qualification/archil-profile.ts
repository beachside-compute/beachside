import { Beachside } from "beachside";
import { archilAdapter } from "@beachside/archil";
import { z } from "zod";
import { defineProviderProfile } from "./profile";
import { features, supportMetadataSchema } from "./support";

const Routing = z.object({
  region: z.enum(["aws-us-east-1", "aws-us-west-2", "aws-eu-west-1"]),
  imageId: z.string().min(1),
  networkPolicy: z.enum(["archil-managed", "internet"]),
  nativeLifetimeSeconds: z.literal(900),
});

const implemented = new Set([
  "lifecycle",
  "execution",
  "streaming",
  "finiteStdin",
  "termination",
  "files",
  "directories",
  "previewProtected",
  "previewPublic",
  "suspension",
  "renewal",
  "reopening",
  "snapshots",
  "volumes",
  "persistence",
  "network",
  "oci",
]);

const notes: Partial<Record<keyof typeof features, string>> = {
  lifecycle:
    "One sandbox from the OCI image `node:24-bookworm` with a 900-second session budget; Archil expiry pauses rather than deletes, so destroy stops the sandbox and waits until Archil no longer returns it.",
  execution:
    "Argv and shell over Archil's process connection, with separate stdout and stderr; output bounded to 1 MiB.",
  finiteStdin: "Exact bytes followed by EOF over the process connection.",
  files: "Reads, overwrites and exclusive-create writes over the process connection.",
  directories: "Copy, move, mkdir, remove, stat, exists and listings through guest helpers.",
  previewProtected: "Per-port token sent as the `X-Archil-Token` header.",
  previewPublic: "Ports exposed without a token when `preview.access` is `public`.",
  suspension:
    "Archil pause keeps memory and processes; resume continues them. With `Preserve.FILESYSTEM` it stops instead and resume cold-boots.",
  renewal: "Sets the current powered-on session's budget, 60 seconds to 24 hours.",
  reopening: "References hold the sandbox id and the account/region scope, never the key.",
  snapshots:
    "Capture forks the source into a retained, paused holder sandbox; restore forks the holder, so `restore()` needs `requireIndependentLifecycle: false`. Checked live by hand; the shared roundtrip requires independent restores and does not apply.",
  volumes: "Archil disks; create, inspect, list and explicit delete.",
  persistence: "Disks mounted into sandboxes at create, read-write or read-only.",
  streaming: "Sustained byte streams, terminals and incremental stdin over the process connection.",
  termination: "SIGTERM and SIGKILL to the process.",
  network:
    "`blocked`, `internet` and allowlists need a paid plan; the Free plan uses `archil-managed`, Archil's managed allowlist.",
  oci: "Any amd64 OCI image, plus `beachside image build` for prepared image ids.",
};

// SAFETY: These keys are taken from the fixed features literal.
const featureIds = Object.keys(features) as (keyof typeof features)[];

export default defineProviderProfile({
  id: "archil",
  nativeVersion: "disk SDK 1.12.0",
  configuredEnvironment: true,
  fileNoClobber: true,
  credentialVariables: ["BEACHSIDE_ARCHIL_API_KEY"],
  bounds: { nativeLifetimeSeconds: 900, exerciseMs: 240000, cleanupMs: 60000 },
  support: {
    id: "archil",
    name: "Archil",
    features: supportMetadataSchema.shape.features.parse(
      Object.fromEntries(
        featureIds.map((id) => [
          id,
          {
            support: implemented.has(id) ? "conditional" : "unsupported",
            note:
              notes[id] ??
              (implemented.has(id)
                ? "Implemented with deterministic native-boundary tests; no live qualification yet."
                : "Not implemented by this adapter."),
          },
        ]),
      ),
    ),
  },
  configure(environment, saved) {
    return Routing.parse(
      saved ?? {
        region: environment.BEACHSIDE_ARCHIL_REGION ?? "aws-us-east-1",
        imageId: environment.BEACHSIDE_ARCHIL_IMAGE ?? "node:24-bookworm",
        networkPolicy: environment.BEACHSIDE_ARCHIL_NETWORK ?? "archil-managed",
        nativeLifetimeSeconds: 900,
      },
    );
  },
  configuration(routing) {
    const config = Routing.parse(routing);

    return {
      imageClass: "oci",
      fileRoot: "/tmp",
      authorityClass: "api-key",
      network: `${config.networkPolicy}-requested`,
      regionClass: config.region,
    };
  },
  connection(routing, credentials) {
    const config = Routing.parse(routing);

    return (onReference, onDiagnostic) =>
      Beachside.connect({
        adapter: archilAdapter,
        credentials: { apiKey: credentials.BEACHSIDE_ARCHIL_API_KEY },
        config: {
          region: config.region,
          image: config.imageId,
          network: config.networkPolicy,
          lifecycle: { lifetimeSeconds: config.nativeLifetimeSeconds },
        },
        cleanup: { storage: "allow-unconfirmed" },
        onReference,
        onDiagnostic,
      });
  },
});
