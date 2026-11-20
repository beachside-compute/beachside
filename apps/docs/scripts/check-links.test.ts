import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Markdown links verify public files and reject missing files, directories, and traversal", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "beachside-doc-links-"));
  const checker = join(fixture, "scripts/check-links.mjs");
  const page = join(fixture, "src/content/docs/index.md");

  try {
    await mkdir(join(fixture, "public/images"), { recursive: true });
    await mkdir(join(fixture, "scripts"), { recursive: true });
    await mkdir(join(fixture, "src/content/docs"), { recursive: true });
    await copyFile(new URL("./check-links.mjs", import.meta.url), checker);
    await writeFile(join(fixture, "public/images/diagram.png"), "public fixture");
    await writeFile(join(fixture, "outside.png"), "private fixture");

    await writeFile(page, "![Diagram](/images/diagram.png)");
    expect(Bun.spawnSync([process.execPath, checker]).exitCode).toBe(0);

    const rejected = ["/images/missing.png", "/images/", "/../outside.png", "/%2e%2e/outside.png"];

    await writeFile(page, rejected.map((href) => `![Diagram](${href})`).join("\n"));
    const result = Bun.spawnSync([process.execPath, checker]);

    expect(result.exitCode).toBe(1);

    for (const href of rejected)
      expect(result.stderr.toString()).toContain(`missing route ${href}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
