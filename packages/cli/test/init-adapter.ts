import { defineAdapter } from "@beachside/adapter";
import { createFakeAdapter } from "@beachside-internal/provider-fake";
import { z } from "zod";

/**
 * The fake behind a token, with the setup `beachside init` asks questions from. It lives apart
 * from fake-adapter.ts because the wizard tests import it in the test process, where other files
 * import that one with their own server's address.
 */
export const initable = defineAdapter({
  name: "fake",
  displayName: "Fake test provider that init can set up",
  setup: {
    credentials: {
      token: {
        env: "FAKE_TOKEN",
        description: "A fake provider token.",
        url: "https://fake.example/keys",
      },
    },
    config: {
      region: { env: "FAKE_REGION", required: true, choices: ["north", "south"] },
      network: { env: "FAKE_NETWORK", choices: ["blocked", "internet"] },
    },
    defaults: { environment: { kind: "prepared", value: "fake-starter" } },
  },
  config: z.strictObject({
    region: z.enum(["north", "south"]),
    network: z.enum(["blocked", "internet"]).optional(),
    environment: z.strictObject({ kind: z.literal("prepared"), value: z.string() }).optional(),
  }),
  credentials: z.strictObject({ token: z.string() }),
  async connect({ config, credentials, host }) {
    // A wrong token reaches the fake server, which refuses it like a provider would.
    // Read at connect, not import: in-process tests from several files share this module.
    const server = z.string().parse(process.env.BEACHSIDE_FAKE_URL);

    const session = await createFakeAdapter({ url: server, token: credentials.token }).connect({
      config: {},
      credentials: {},
      host,
    });

    return config.environment ? { ...session, defaultImage: config.environment } : session;
  },
});
