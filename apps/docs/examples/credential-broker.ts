import type { BeachsideClient } from "beachside";
import { createCredentialBroker, type CredentialBrokerOptions } from "@beachside/credential-client";

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
      credentials: broker.sandbox({
        github: "github-work",
        openrouter: "router-work",
        ttlSeconds: 900,
      }),
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
