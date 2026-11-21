import { expect, test } from "bun:test";
import { redact, registerSecret } from "../src/output";

test("redact removes a registered secret and its base64 and URL-encoded forms", () => {
  const secret = "sk_live/abc+def=ghi";
  registerSecret(secret);

  const base64 = Buffer.from(secret).toString("base64").replace(/=+$/, "");

  expect(redact(`key ${secret} sent`)).toBe("key [redacted] sent");
  expect(redact(`Authorization: Basic ${base64}==`)).toBe("Authorization: Basic [redacted]==");
  expect(redact(`?token=${encodeURIComponent(secret)}`)).toBe("?token=[redacted]");
});

test("redact leaves short values alone, so a region or a flag is never mangled", () => {
  registerSecret("us");
  expect(redact("region us-east")).toBe("region us-east");
});
