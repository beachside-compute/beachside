import { expect } from "bun:test";

// Await fixture I/O before using an expect matcher. Bun 1.4 can stall
// loopback gRPC calls while matching a pending rejection.
export async function expectRejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return expect(error);
  }

  throw new Error("Expected a rejected promise");
}
