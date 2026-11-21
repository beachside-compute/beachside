// Builds dist/main.js. The @clack packages' node:util imports go through src/node-util-compat.ts so the
// bundle still links on Node 20 releases before styleText existed.
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const compat = fileURLToPath(new URL("../src/node-util-compat.ts", import.meta.url));

await rm(`${root}dist`, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${root}src/main.ts`],
  outdir: `${root}dist`,
  target: "node",
  format: "esm",
  external: ["beachside", "@beachside/adapter", "zod"],
  plugins: [
    {
      name: "node-util-compat",
      setup(build) {
        build.onResolve({ filter: /^(node:)?util$/ }, (args) =>
          /[\\/]@clack[\\/+]/.test(args.importer) ? { path: compat } : undefined,
        );
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const output = await readFile(`${root}dist/main.js`, "utf8");

if (/import\s*\{[^}]*\bstyleText\b[^}]*\}\s*from\s*["']node:util["']/.test(output)) {
  console.error("dist/main.js imports styleText from node:util, which Node 20 before 20.12 lacks");
  process.exit(1);
}
