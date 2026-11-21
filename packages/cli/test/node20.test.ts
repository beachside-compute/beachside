import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// @clack/prompts imports `styleText` from node:util, which only exists from Node 20.12. The build
// bundles it, so a static import anywhere in src would hoist that import into the entry chunk
// and stop every command on older Node 20 (as on E2B's base template). Load these lazily only.
const lateModules = ["@clack/prompts", "@clack/core", "@beachside/credential-client/cli"];

test("Node 20.12-only modules are never imported statically", async () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];

  for (const name of await readdir(src)) {
    if (!name.endsWith(".ts")) continue;

    const text = await readFile(join(src, name), "utf8");

    // Static value imports, single- or multi-line; `import type` is erased by the build.
    for (const [statement] of text.matchAll(/^import\s(?!type\s)[^;]*?["'][^"']+["'];?/gms))
      for (const module of lateModules)
        if (statement.includes(`"${module}"`)) offenders.push(`${name}: ${statement}`);
  }

  // init-prompts.ts is itself only ever reached through `await import("./init-prompts")`.
  expect(offenders.filter((line) => !line.startsWith("init-prompts.ts:"))).toEqual([]);
});

test("init-prompts is loaded with a dynamic import only", async () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];

  for (const name of await readdir(src)) {
    if (!name.endsWith(".ts")) continue;

    const text = await readFile(join(src, name), "utf8");

    if (/^\s*import\s(?!type\s).*["']\.\/init-prompts["']/m.test(text)) offenders.push(name);
  }

  expect(offenders).toEqual([]);
});
