import type { BrokerConfig } from "../config";
import { bearer, grantTokenPattern } from "../grants/tokens";
import { matchesKey } from "./api-key";
import { githubActionsPrincipal } from "./github-oidc";

export interface Principal {
  owner: string;
  integrations: string[];
  admin: boolean;
}

export async function orchestrator(
  request: Request,
  config: BrokerConfig,
  apiKey: string | undefined,
): Promise<Principal | undefined> {
  const token = bearer(request.headers.get("authorization"));

  if (!token || token.length > 8192 || grantTokenPattern.test(token)) return;

  if (await matchesKey(apiKey, token)) {
    return {
      owner: "broker-api-key",
      integrations: config.integrations.map(({ id }) => id),
      admin: true,
    };
  }

  return githubActionsPrincipal(token, config);
}
