import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRex, registerRexHost } from "../src/rex-local";

test("detects an override or executable on PATH", async () => {
  expect(await findRex({ BEACHSIDE_REX_BIN: "/custom/rex" })).toBe("/custom/rex");
  const directory = await mkdtemp(join(tmpdir(), "rex-detection-"));

  try {
    const executable = join(directory, process.platform === "win32" ? "rex.exe" : "rex");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    expect(await findRex({ PATH: directory })).toBe(executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const scenario of ["missing", "unsupported", "success", "failure"] as const) {
  test(`registration: ${scenario}`, async () => {
    const calls: string[][] = [];
    const notes: string[] = [];
    await registerRexHost(
      "beachside-web",
      "https://web.example.ts.net",
      { REX_SERVER: "https://unrelated.example.ts.net" },
      new AbortController().signal,
      { note: (text) => notes.push(text) },
      {
        find: async () => (scenario === "missing" ? undefined : "/rex"),
        run: async (_binary, args) => {
          calls.push(args);

          if (scenario === "unsupported") throw new Error("unknown command hosts");

          if (scenario === "failure") throw new Error("label already exists");

          return "";
        },
      },
    );
    expect(calls.some((args) => args[0] === "hosts")).toBe(scenario !== "missing");

    if (scenario === "success") {
      expect(calls[0]).toEqual(["hosts", "add", "beachside-web", "https://web.example.ts.net"]);
      expect(notes[0]).toContain("registered");
    } else {
      const messages = {
        missing: "not found",
        unsupported: "unknown command hosts",
        failure: "label already exists",
      };

      expect(notes[0]).toContain(messages[scenario]);
    }
  });
}
