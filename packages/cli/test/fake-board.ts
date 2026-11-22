// A stand-in beachbar Worker for `beachside board` and `create --board` tests: it answers the
// token and status calls beachbar's client makes, logs each one, and can be told to fail.
export const boardToken = `bbr_${"x".repeat(43)}`;

export const tokenId = "tok_abcdefghijkl";

export type BoardMode = {
  rateLimited?: boolean;
  garbled?: boolean;
  revokeGone?: boolean;
};

export type BoardCall = { method: string; path: string; body: unknown };

type BoardErrorBody = { code: string; reason: string; message: string; next: string[] };

type Envelope = { ok: true; data: unknown } | { ok: false; error: BoardErrorBody };

function reply(envelope: Envelope, status = 200): Response {
  return Response.json(envelope, { status });
}

function failure(status: number, code: string, reason: string, message: string): Response {
  return reply({ ok: false, error: { code, reason, message, next: [] } }, status);
}

export async function startFakeBoard() {
  const calls: BoardCall[] = [];
  let mode: BoardMode = {};

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const match = /^\/v1\/b\/(b_[a-z0-9]+)(\/.*)$/.exec(url.pathname);
      const path = match?.[2] ?? url.pathname;

      const text =
        request.method === "GET" || request.method === "DELETE" ? "" : await request.text();

      const body: unknown = text === "" ? null : JSON.parse(text);

      calls.push({ method: request.method, path, body });

      if (request.method === "POST" && path === "/tokens") {
        if (mode.rateLimited)
          return failure(429, "RATE_LIMITED", "rate_limited", "Too many writes.");

        // A Worker that crashed halfway: the token is in the answer, but not as JSON.
        if (mode.garbled) return new Response(`{"ok":true,"data":{"token":"${boardToken}"`);

        // SAFETY: beachbar's client sends this body for a mint.
        const { agent, role } = body as { agent: string; role: string };

        return reply({
          ok: true,
          data: {
            id: tokenId,
            agent,
            role,
            createdAt: 1,
            expiresAt: Date.UTC(2030, 0, 1),
            revokedAt: null,
            token: boardToken,
          },
        });
      }

      if (request.method === "DELETE" && path.startsWith("/tokens/")) {
        const id = path.slice("/tokens/".length);

        if (mode.revokeGone) return failure(404, "NOT_FOUND", "token_not_found", `No token ${id}.`);

        return reply({
          ok: true,
          data: { id, agent: "w", role: "worker", createdAt: 1, expiresAt: null, revokedAt: 2 },
        });
      }

      if (request.method === "GET" && path === "/tokens") return reply({ ok: true, data: [] });

      return failure(404, "NOT_FOUND", "no_route", `No route ${request.method} ${path}.`);
    },
  });

  const origin = `http://127.0.0.1:${server.port}`;

  return {
    calls,
    url: (id: string) => `${origin}/v1/b/${id}`,
    set(next: BoardMode) {
      mode = next;
    },
    reset() {
      mode = {};
      calls.length = 0;
    },
    stop: () => server.stop(true),
  };
}
