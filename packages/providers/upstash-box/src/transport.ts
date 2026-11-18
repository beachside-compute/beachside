import { AdapterError, type AdapterErrorCode, type Json } from "@beachside/adapter";
import { z } from "zod";

export const ORIGIN = "https://us-east-1.box.upstash.com";
export const RANGE_BYTES = 8 * 1024 * 1024;
const JSON_BYTES = 12 * 1024 * 1024;

export function nativeCode(status: number): AdapterErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMIT";
    default:
      return "UNAVAILABLE";
  }
}

export class BoxHttpError extends AdapterError {
  constructor(readonly status: number) {
    super(nativeCode(status), `Upstash Box returned HTTP ${status}`);
  }
}

export function definitiveRefusal(error: unknown): error is BoxHttpError {
  return error instanceof BoxHttpError && [400, 401, 403, 404, 422, 429].includes(error.status);
}

const Base64 = z.base64();

export function decodeBytes(value: string, max: number): Buffer {
  const encodedLimit = Math.ceil(max / 3) * 4;

  if (value.length > encodedLimit || !Base64.safeParse(value).success)
    throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid or oversized base64");
  const bytes = Buffer.from(value, "base64");

  if (bytes.length > max || bytes.toString("base64") !== value)
    throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid or oversized base64");

  return bytes;
}

export function createTransport(origin: string, apiKey: string, fetcher: typeof fetch) {
  async function request(
    path: string,
    signal: AbortSignal,
    method = "GET",
    body?: Record<string, Json>,
  ) {
    const response = await fetcher(origin + path, {
      method,
      signal,
      redirect: "error",
      headers: { "X-Box-Api-Key": apiKey, ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new BoxHttpError(response.status);
    }

    return response;
  }

  async function json(
    path: string,
    signal: AbortSignal,
    method?: string,
    body?: Record<string, Json>,
  ) {
    const response = await request(path, signal, method, body);

    if (!response.body) throw new AdapterError("UNAVAILABLE", "Upstash Box returned no JSON");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;
        bytes += chunk.value.byteLength;

        if (bytes > JSON_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new AdapterError("UNAVAILABLE", "Upstash Box returned oversized JSON");
        }

        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }

    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));

      return value;
    } catch {
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid JSON");
    }
  }

  async function empty(
    path: string,
    signal: AbortSignal,
    method: string,
    body?: Record<string, Json>,
  ) {
    const response = await request(path, signal, method, body);
    await response.body?.cancel().catch(() => undefined);
  }

  return { json, empty };
}

export type Transport = ReturnType<typeof createTransport>;
