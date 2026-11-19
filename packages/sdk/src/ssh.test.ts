import { expect, test } from "bun:test";
import { z } from "zod";
import { defineAdapter, type SshCapabilities, type SshTarget } from "@beachside/adapter";
import { Image, Beachside } from "./index";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

type Target = (input: { sandboxId: string; publicKey?: string }) => Promise<SshTarget>;

async function fixture(ssh?: { supports: SshCapabilities; target: Target }) {
  const adapter = defineAdapter({
    name: "ssh.fixture",
    config: z.object({}),
    credentials: z.object({}),
    async connect() {
      return {
        scope: { authority: { kind: "test", id: "one" }, partition: {} },
        supports: { images: ["prepared"], network: ["blocked"] },
        create: async () => ({ id: "one", state: "running" as const }),
        destroy: async () => ({ computeStopped: true, retainedResources: [] }),
        ssh: ssh
          ? {
              supports: ssh.supports,
              target: async (input) =>
                ssh.target({ sandboxId: input.sandbox.id, publicKey: input.publicKey }),
            }
          : undefined,
      };
    },
  });

  const client = await Beachside.connect({ adapter, config: {}, credentials: {}, tracing: false });

  return { client, box: await client.sandboxes.create({ environment: Image.prepared("base") }) };
}

const keyed: SshCapabilities = {
  auth: "publicKey",
  publicKey: "optional",
  scope: "account",
  hostKeys: true,
  expires: false,
  proxy: "none",
};

test("capabilities report SSH support from the adapter declaration without calling it", async () => {
  let calls = 0;

  const { client } = await fixture({
    supports: keyed,
    target: async () => {
      calls++;
      throw new Error("not reached");
    },
  });

  try {
    expect((await client.capabilities()).ssh).toEqual({ status: "supported", value: keyed });
    expect(calls).toBe(0);
  } finally {
    await client.close();
  }
});

test("adapters without SSH report unsupported and refuse sshTarget", async () => {
  const { client, box } = await fixture();

  try {
    expect((await client.capabilities()).ssh).toEqual({
      status: "unsupported",
      reason: "This adapter does not provide SSH targets",
    });
    await expect(box.sshTarget()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await client.close();
  }
});

test("sshTarget normalizes the caller's public key and returns the adapter's target", async () => {
  const seen: (string | undefined)[] = [];

  const { client, box } = await fixture({
    supports: keyed,
    target: async ({ publicKey }) => {
      seen.push(publicKey);

      return {
        host: "proxy.example.test",
        port: 10022,
        username: "boxd",
        auth: { method: "publicKey" },
        hostKeys: [KEY],
      };
    },
  });

  try {
    expect(await box.sshTarget({ publicKey: `${KEY} me@laptop\n` })).toEqual({
      host: "proxy.example.test",
      port: 10022,
      username: "boxd",
      auth: { method: "publicKey" },
      hostKeys: [KEY],
    });
    await box.sshTarget();
    expect(seen).toEqual([KEY, undefined]);

    for (const publicKey of ["", "ssh-ed25519", "not-a-key AAAA", `${KEY}\nssh-rsa AAAA`])
      await expect(box.sshTarget({ publicKey })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    expect(seen).toHaveLength(2);
  } finally {
    await client.close();
  }
});

test("required public keys are checked before dispatch and unused ones are not forwarded", async () => {
  const seen: (string | undefined)[] = [];

  const required = await fixture({
    supports: { ...keyed, publicKey: "required", scope: "sandbox" },
    target: async ({ publicKey }) => {
      seen.push(publicKey);

      return {
        host: "203.0.113.7",
        port: 22,
        username: "user",
        auth: { method: "publicKey" },
        hostKeys: [KEY],
      };
    },
  });

  await expect(required.box.sshTarget()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(seen).toEqual([]);
  await required.client.close();

  const minted = await fixture({
    supports: {
      auth: "privateKey",
      publicKey: "unused",
      scope: "sandbox",
      hostKeys: false,
      expires: false,
      proxy: "tls",
    },
    target: async ({ publicKey }) => {
      seen.push(publicKey);

      return {
        host: "dbx_1.ssh.example.test",
        port: 22,
        username: "user",
        auth: {
          method: "privateKey",
          privateKey:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
        },
        proxy: { kind: "tls", host: "ssh.example.test", port: 443, serverName: "dbx_1.example" },
      };
    },
  });

  expect((await minted.box.sshTarget({ publicKey: KEY })).auth.method).toBe("privateKey");
  expect(seen).toEqual([undefined]);
  await minted.client.close();
});

test("targets that disagree with the declared capabilities or leak control characters are refused", async () => {
  const targets: SshTarget[] = [
    {
      host: "h.example.test",
      port: 22,
      username: "u",
      auth: { method: "password", password: "p" },
    },
    { host: "h.example.test", port: 22, username: "u", auth: { method: "publicKey" } },
    {
      host: "h.example.test",
      port: 22,
      username: "u\nx",
      auth: { method: "publicKey" },
      hostKeys: [KEY],
    },
    {
      host: "h.example.test",
      port: 0,
      username: "u",
      auth: { method: "publicKey" },
      hostKeys: [KEY],
    },
  ];

  let next = 0;

  const { client, box } = await fixture({ supports: keyed, target: async () => targets[next++]! });

  try {
    for (const _ of targets)
      await expect(box.sshTarget()).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        message: "Invalid SSH target response",
      });
  } finally {
    await client.close();
  }
});

test("expiring targets must carry expiresAt and adapter errors keep their code", async () => {
  let fail = true;

  const { client, box } = await fixture({
    supports: { ...keyed, auth: "none", publicKey: "unused", hostKeys: false, expires: true },
    target: async () => {
      if (fail) throw new (await import("@beachside/adapter")).AdapterError("CONFLICT", "stopped");

      return { host: "ssh.example.test", port: 22, username: "token", auth: { method: "none" } };
    },
  });

  try {
    await expect(box.sshTarget()).rejects.toMatchObject({ code: "CONFLICT" });
    fail = false;
    await expect(box.sshTarget()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  } finally {
    await client.close();
  }
});
