import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type Gateway = "kilo" | "openrouter";

export function selectedGateway(args: string[]): Gateway | undefined {
  const kilo = args.includes("--kilo");
  const openrouter = args.includes("--openrouter");

  if ((kilo && openrouter) || ((kilo || openrouter) && args.includes("--offline"))) {
    throw new Error("Choose one of --kilo, --openrouter, or --offline.");
  }

  if (openrouter) return "openrouter";

  if (kilo) return "kilo";

  return undefined;
}

export function gatewayConfig(gateway: Gateway, env: Record<string, string | undefined>) {
  const name = gateway === "openrouter" ? "OpenRouter" : "Kilo Gateway";
  const keyName = gateway === "openrouter" ? "OPENROUTER_API_KEY" : "KILO_API_KEY";

  const modelId =
    env.DEFAULT_MODEL?.trim() ||
    (gateway === "openrouter" ? env.PI_TRACING_MODEL?.trim() : undefined);

  const baseUrl =
    gateway === "openrouter"
      ? env.OPENROUTER_BASE_URL?.trim()
      : "https://ai-gateway.kilo.ai/api/v1";

  if (!modelId || !env[keyName]?.trim()) {
    throw new Error(
      gateway === "kilo"
        ? "Kilo requires DEFAULT_MODEL and KILO_API_KEY."
        : "OpenRouter requires DEFAULT_MODEL (or PI_TRACING_MODEL) and OPENROUTER_API_KEY.",
    );
  }

  const url = baseUrl ? URL.parse(baseUrl) : null;

  if (
    !baseUrl ||
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Set OPENROUTER_BASE_URL to an HTTPS Chat Completions API base URL without credentials or query parameters.",
    );
  }

  return { name, keyName, modelId, baseUrl, hostname: url.hostname };
}

export function registerGatewayModel(
  modelRuntime: ModelRuntime,
  gateway: Gateway,
  env: Record<string, string | undefined>,
) {
  const { name, keyName, modelId, baseUrl } = gatewayConfig(gateway, env);

  const luna = gateway === "openrouter" && modelId === "openai/gpt-6-luna";

  modelRuntime.registerProvider(gateway, {
    name,
    baseUrl,
    apiKey: `$${keyName}`,
    api: "openai-completions",
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: luna,
        thinkingLevelMap: luna ? { off: "none" } : undefined,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4_096,
        compat: {
          thinkingFormat: luna ? "openrouter" : undefined,
          maxTokensField: "max_tokens",
          supportsDeveloperRole: false,
          supportsStore: false,
        },
      },
    ],
  });
  const model = modelRuntime.getModel(gateway, modelId);

  if (!model) throw new Error(`Pi could not register the selected ${name} model.`);

  return model;
}
