import { z } from "zod";
import type { CredentialSource } from "../source";

const credential = z.string().regex(/^[\x21-\x7e]{1,4096}$/);

export type WorkerSecretBindings = Partial<Record<`CREDENTIAL_${string}`, string>>;

export function workerSecretSource(bindings: WorkerSecretBindings): CredentialSource {
  return {
    async resolve(reference) {
      const descriptor = Object.getOwnPropertyDescriptor(bindings, reference.binding);
      const parsed = credential.safeParse(descriptor?.value);

      return parsed.success ? { value: parsed.data } : undefined;
    },
  };
}
