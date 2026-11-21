#!/usr/bin/env bun
// A stand-in for the beachbar command in `beachside board` and `create --board` tests. It logs
// its arguments, answers `token mint` and `token revoke` as beachbar does with --json, and
// prints its arguments for anything else.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

if (process.env.FAKE_BEACHBAR_LOG)
  appendFileSync(process.env.FAKE_BEACHBAR_LOG, `${JSON.stringify(args)}\n`);

const words = args.filter((arg) => arg !== "--json");

if (words[0] === "token" && words[1] === "mint") {
  if (process.env.FAKE_BEACHBAR_FAIL) {
    console.log(
      JSON.stringify({
        ok: false,
        error: {
          code: "NOT_FOUND",
          reason: "unknown_board",
          message: "No board named nope in the config.",
          next: ["beachbar board ls"],
        },
      }),
    );
    process.exit(3);
  }

  console.log(
    JSON.stringify({
      ok: true,
      data: {
        id: "tok_abcdefghijkl",
        agent: words[2],
        role: words[words.indexOf("--role") + 1],
        createdAt: 1,
        expiresAt: Date.UTC(2030, 0, 1),
        revokedAt: null,
        token: `bbr_${"x".repeat(43)}`,
        url: "https://beachbar.example.workers.dev/v1/b/b_aaaaaaaaaaaaaaaaaaaa",
      },
    }),
  );
  process.exit(0);
}

if (words[0] === "token" && words[1] === "revoke") {
  console.log(JSON.stringify({ ok: true, data: { id: words[2] } }));
  process.exit(0);
}

console.log(`beachbar ${args.join(" ")}`);

process.exit(words[0] === "fail" ? 4 : 0);
