import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../../");

function reportsSpacing(source: string): boolean {
  const directory = mkdtempSync(join(tmpdir(), "beachside-spacing-"));
  try {
    const file = join(directory, "probe.ts");
    writeFileSync(file, source);
    const result = Bun.spawnSync([join(root, "node_modules/.bin/oxlint"), "--config", join(root, ".oxlintrc.json"), "--format", "json", file], { cwd: root, stdout: "pipe" });
    const output = JSON.parse(new TextDecoder().decode(result.stdout)) as { diagnostics: Array<{ code: string }> };
    return output.diagnostics.some((diagnostic) => diagnostic.code === "anti-slop(require-readable-spacing)");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("groups adjacent single-line exported bindings", () => {
  expect(reportsSpacing("export const a = 1;\nexport const b = 2;\n")).toBe(false);
});

test("separates a binding with a leading comment", () => {
  expect(reportsSpacing("export const a = 1;\n/** B */\nexport const b = 2;\n")).toBe(true);
});
