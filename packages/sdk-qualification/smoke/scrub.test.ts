import { expect, test } from "bun:test";
import { Scrubber } from "./scrub";

test("scrubs secrets in plain, base64 and URL-encoded form and counts each hit", () => {
  const secret = "live-key/with+chars=1";
  const scrubber = new Scrubber([secret, "us"]);

  const text = [
    `key=${secret}`,
    `basic ${Buffer.from(secret).toString("base64")}`,
    `url ?k=${encodeURIComponent(secret)}`,
    "region us",
  ].join("\n");

  const result = scrubber.scrub(text);

  expect(result).not.toContain(secret);
  expect(result).not.toContain(Buffer.from(secret).toString("base64").replace(/=+$/, ""));
  expect(result).not.toContain(encodeURIComponent(secret));
  expect(result).toContain("region us");
  expect(scrubber.hits).toBe(3);
});

test("scrubs token shapes nobody registered", () => {
  const scrubber = new Scrubber([]);
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzbW9rZSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";

  const result = scrubber.scrub(
    `token ${jwt}\nAuthorization: Bearer abcdefghijklmnop\nkey e2b_0123456789abcdef`,
  );

  expect(result).toBe(
    "token [redacted-token]\nAuthorization: Bearer [redacted-token]\nkey [redacted-token]",
  );
  expect(scrubber.hits).toBe(3);
});
