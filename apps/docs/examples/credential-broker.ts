import type { BeachsideClient } from "beachside";
import {
  createCredentialBroker,
  createCredentialBrokerAdmin,
  type CredentialBrokerAdminOptions,
  type CredentialBrokerOptions,
} from "@beachside/credential-client";

/** Prepare the two integrations used by runOpenCode on a new deployment. */
export async function provisionOpenCodeBroker(
  options: CredentialBrokerAdminOptions,
  upstream: { github: string; openrouter: string },
) {
  const admin = createCredentialBrokerAdmin(options);

  const github = await admin.integrations.create({
    id: "github",
    kind: "github",
    credential: { source: "encrypted-store", value: upstream.github },
  });

  const openrouter = await admin.integrations.create({
    id: "openrouter",
    kind: "http",
    endpoint: {
      baseURL: "https://openrouter.ai/api/v1",
      headers: [{ name: "Authorization", secret: true, prefix: "Bearer " }],
    },
    credential: { source: "encrypted-store", values: { Authorization: upstream.openrouter } },
  });

  return admin.issuerPermissions.set([github.id, openrouter.id]);
}

export async function runOpenCode(
  client: BeachsideClient,
  options: CredentialBrokerOptions,
  repository: string,
  model: string,
) {
  const broker = createCredentialBroker(options);
  const project = "/tmp/beachside-project";

  return client.sandboxes.with(
    {
      network: "internet",
      // github configures git and gh; openrouter sets OPENROUTER_BASE_URL and OPENROUTER_API_KEY.
      grant: broker.sandbox({ integrations: ["github", "openrouter"], ttlSeconds: 900 }),
      setup: [["git", "clone", `https://github.com/${repository}.git`, project]],
    },
    async (box) => {
      await box.exec(["gh", "api", `repos/${repository}`, "--jq", ".full_name"]);
      await box.exec(["mkdir", "-p", `${project}/.opencode`]);
      await box.writeTextFile(
        `${project}/.opencode/opencode.json`,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          providers: {
            openrouter: {
              settings: {
                baseURL: "{env:OPENROUTER_BASE_URL}",
                apiKey: "{env:OPENROUTER_API_KEY}",
              },
            },
          },
        }),
        { overwrite: false },
      );

      return box.exec({
        command: {
          kind: "argv",
          argv: ["opencode", "run", "--model", model, "Summarize this repository."],
        },
        cwd: project,
      });
    },
  );
}
