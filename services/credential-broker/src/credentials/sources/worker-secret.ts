import { z } from "zod";
import type { CredentialReference } from "../../config";
import type { CredentialSource } from "../source";

const credential = z.string().regex(/^[\x21-\x7e]{1,4096}$/);

export type WorkerSecretBindings = Partial<Record<CredentialReference["binding"], string>>;

export function workerSecretSource(bindings: WorkerSecretBindings): CredentialSource {
  return {
    async resolve(reference) {
      const parsed = credential.safeParse(bindings[reference.binding]);

      return parsed.success ? { value: parsed.data } : undefined;
    },
  };
}
