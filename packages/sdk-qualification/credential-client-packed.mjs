import assert from "node:assert/strict";
import { defineAdapter } from "@beachside/adapter";
import { createCredentialBroker } from "@beachside/credential-client";
import { Beachside } from "beachside";
import { z } from "zod";

const token = `bsg_${"9".repeat(64)}`;

const id = "685daa5a-0771-4ef8-9e41-3a5a913e7a04";

const key = "fixture_credential_broker_control_key";

const events = [];

const broker = createCredentialBroker({
  url: "https://broker.example.invalid",
  auth: { apiKey: key },
  async fetch(request) {
    assert.equal(request.headers.get("authorization"), `Bearer ${key}`);

    if (request.method === "DELETE") {
      assert.equal(new URL(request.url).pathname, `/v1/grants/${id}`);
      events.push("revoke");

      return new Response(null, { status: 204 });
    }

    assert.deepEqual(await request.json(), { integrations: ["gpt"], ttlSeconds: 900 });
    events.push("issue");

    return Response.json(
      { id, token, expiresAt: new Date(Date.now() + 60_000).toISOString(), integrations: ["gpt"] },
      { status: 201 },
    );
  },
});

const adapter = defineAdapter({
  name: "credential.packed",
  config: z.strictObject({}),
  credentials: z.strictObject({}),
  async connect() {
    return {
      scope: { authority: { kind: "fixture", id: "account" }, partition: {} },
      defaultImage: { kind: "prepared", value: "fixture" },
      supports: {
        images: ["prepared"],
        network: ["internet"],
        exec: { commands: ["argv"], maxOutputBytes: 1_048_576 },
      },
      async create(input) {
        assert.equal(input.env, undefined);
        events.push("create");

        return { id: "box", state: "running" };
      },
      async exec(input) {
        assert.deepEqual(input.env, {
          OPENAI_API_KEY: token,
          OPENAI_BASE_URL: "https://broker.example.invalid/gateway/gpt/v1",
        });
        events.push("exec");

        return {
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
        };
      },
      async destroy() {
        events.push("destroy");

        return { computeStopped: true, retainedResources: [] };
      },
    };
  },
});

const client = await Beachside.connect({ adapter, credentials: {}, config: {} });

try {
  await client.sandboxes.with(
    { credentials: broker.sandbox({ openai: "gpt" }), network: "internet" },
    (box) => box.exec(["true"]),
  );

  assert.deepEqual(events.slice(0, 3), ["create", "issue", "exec"]);
  assert.deepEqual(events.slice(3).sort(), ["destroy", "revoke"]);
  console.log("Packed client configured and revoked a sandbox grant");
} finally {
  await client.close();
}
