import { expect, test } from "bun:test";
import { Image, Beachside, type AdapterRecoveryReference } from "beachside";
import { createDaytonaAdapter } from "./adapter";

function fixture() {
  let creates = 0;
  let status = 200;
  let unavailable = false;
  let token = "private-preview-token";
  let previewUrl = "https://3000-native-reopen.proxy.daytona.work";
  let previewStatus = 200;
  let previewId = "native-reopen";

  type CreationLabels = Record<string, string>;

  const labels: CreationLabels = {};

  const native = {
    id: "native-reopen",
    name: "",
    organizationId: "org-1",
    target: "us",
    state: "started",
    labels,
    networkBlockAll: true,
    public: false,
    autoDestroyAt: "2026-10-01T01:00:00Z",
    autoStopInterval: 5,
    autoDeleteInterval: -1,
  };

  const calls: string[] = [];
  let signedExpiry: string | null = null;
  let sshMinutes: string | null = null;
  let sshToken = "sshTokenAbc123";
  let sshCommand: string | undefined;
  let sshExpiresAt = "2099-01-01T00:00:00.000Z";

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots/prepared")
        return Response.json({
          id: "prepared",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (url.pathname === "/api/sandbox" && method === "POST") {
        creates++;
        Object.assign(native, JSON.parse(String(init?.body)));

        return Response.json(native);
      }

      if (url.pathname === "/api/sandbox" && method === "GET")
        return Response.json({ items: [native] });

      if (url.pathname.endsWith("/ssh-access") && method === "POST") {
        sshMinutes = url.searchParams.get("expiresInMinutes");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer first-key" });

        return Response.json(
          {
            id: "access-1",
            sandboxId: previewId,
            token: sshToken,
            expiresAt: sshExpiresAt,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
            sshCommand: sshCommand ?? `ssh ${sshToken}@ssh.app.daytona.io`,
          },
          { status: previewStatus },
        );
      }

      if (url.pathname.endsWith("/ports/3000/signed-preview-url")) {
        signedExpiry = url.searchParams.get("expiresInSeconds");

        return Response.json({
          sandboxId: previewId,
          port: 3000,
          url: "https://3000-signedtoken.proxy.daytona.work",
          token: "signedtoken",
        });
      }

      if (url.pathname.endsWith("/preview-url")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer first-key" });

        return Response.json(
          { sandboxId: previewId, url: previewUrl, token },
          { status: previewStatus },
        );
      }

      if (url.pathname === "/api/sandbox/native-reopen") {
        if (unavailable) throw new TypeError("offline transport fault");

        return Response.json(native, { status });
      }

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect() {} },
  );

  const adapter = createDaytonaAdapter(fetcher);

  return {
    native,
    preview(tokenValue: string, urlValue = previewUrl, statusValue = 200, idValue = previewId) {
      token = tokenValue;
      previewUrl = urlValue;
      previewStatus = statusValue;
      previewId = idValue;
    },
    calls,
    signedExpiry: () => signedExpiry,
    sshMinutes: () => sshMinutes,
    ssh(token: string, command?: string, expiresAt = sshExpiresAt) {
      sshToken = token;
      sshCommand = command;
      sshExpiresAt = expiresAt;
    },
    creates: () => creates,
    connect: (
      key = "first-key",
      onReference?: (ref: AdapterRecoveryReference) => void,
      preview?: { access: "public"; expiresInSeconds?: number },
      ssh?: { expiresInMinutes: number },
    ) =>
      Beachside.connect({
        adapter,
        config: {
          target: "us",
          networkPolicy: "blocked",
          ttlMinutes: 15,
          ...(preview && { preview }),
          ...(ssh && { ssh }),
        },
        credentials: { apiKey: key },
        onReference,
      }),
    status(value: number) {
      status = value;
    },
    unavailable() {
      unavailable = true;
    },
  };
}

async function create(f: ReturnType<typeof fixture>) {
  const client = await f.connect();
  const box = await client.sandboxes.create({ environment: Image.prepared("prepared") });

  return { client, box };
}

test("Daytona SSH targets mint a token-in-username gateway login with a capped expiry", async () => {
  const f = fixture();
  const { client, box } = await create(f);

  try {
    const reference = JSON.stringify(box.reference);
    const calls = f.calls.length;
    expect((await client.capabilities()).ssh).toMatchObject({
      status: "supported",
      value: { auth: "none", publicKey: "unused", scope: "sandbox", expires: true },
    });
    expect(f.calls.length).toBe(calls);

    const before = Date.now();
    const target = await box.sshTarget();
    expect(target).toMatchObject({
      host: "ssh.app.daytona.io",
      port: 22,
      username: "sshTokenAbc123",
      auth: { method: "none" },
    });
    // The native expiry is later than requested, so the requested hour wins.
    expect(Date.parse(target.expiresAt!)).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect(Date.parse(target.expiresAt!)).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(f.sshMinutes()).toBe("60");
    expect(JSON.stringify(box.reference)).toBe(reference);
    expect(reference).not.toContain("sshTokenAbc123");

    f.ssh("tok2", "ssh -p 2222 tok2@ssh.daytona.example", "2026-01-01T00:00:00Z");
    expect(await box.sshTarget()).toMatchObject({
      host: "ssh.daytona.example",
      port: 2222,
      username: "tok2",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });

    f.ssh("tok3", "ssh other@ssh.app.daytona.io");
    const failure = await box.sshTarget().catch((error: Error) => error);
    expect(failure).toMatchObject({ code: "UNAVAILABLE" });
    expect(String(failure)).not.toContain("tok3");

    f.native.state = "stopped";
    const minted = f.calls.filter((call) => call.endsWith("ssh-access")).length;
    await expect(box.sshTarget()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.calls.filter((call) => call.endsWith("ssh-access")).length).toBe(minted);
  } finally {
    await client.close();
  }
});

test("Daytona SSH token lifetime comes from adapter setup", async () => {
  const f = fixture();
  const client = await f.connect("first-key", undefined, undefined, { expiresInMinutes: 15 });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("prepared") });
    const target = await box.sshTarget();
    expect(f.sshMinutes()).toBe("15");
    expect(Date.parse(target.expiresAt!)).toBeLessThanOrEqual(Date.now() + 900_000);
  } finally {
    await client.close();
  }
});
