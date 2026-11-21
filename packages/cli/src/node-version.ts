import { CliError } from "./output";

/**
 * The prompt library (and the broker command line, which uses it) imports `styleText` from
 * `node:util`, added in Node 20.12. Everything else runs on any Node 20, so only those paths check.
 */
export function requirePromptNode(what: string, hint: string): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

  if (major > 20 || (major === 20 && minor >= 12)) return;

  throw new CliError(
    "UNSUPPORTED",
    `${what} needs Node 20.12 or newer; this is Node ${process.versions.node}`,
    hint,
  );
}
