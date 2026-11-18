import type { CredentialReference } from "../config";

export interface ResolvedCredential {
  value: string;
  expiresAt?: number;
}

export interface CredentialSource {
  resolve(reference: CredentialReference): Promise<ResolvedCredential | undefined>;
}
