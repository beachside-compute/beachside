import { usage } from "./output";

/** A POSIX-style environment variable name. */
export const EnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const escapes = new Map([
  ["n", "\n"],
  ['"', '"'],
  ["\\", "\\"],
]);

/**
 * One `--env-file` value: unquoted text up to a ` #` comment, trimmed; `"..."` with `\n`, `\"`
 * and `\\` escapes; or literal `'...'`. A comment may follow a closing quote. The error names
 * the problem only, since the value may be a secret.
 */
function envFileValue(text: string): { value: string } | { error: string } {
  const value = text.trimStart();
  const quote = value[0];

  if (quote !== '"' && quote !== "'") return { value: text.replace(/\s#.*$/s, "").trim() };

  let parsed = "";
  let end = -1;

  for (let at = 1; at < value.length; at++) {
    const char = value[at]!;

    if (char === quote) {
      end = at;
      break;
    }

    if (quote === '"' && char === "\\" && at + 1 < value.length) {
      const next = value[++at]!;
      parsed += escapes.get(next) ?? `\\${next}`;
    } else parsed += char;
  }

  if (end < 0)
    return { error: "has an unterminated quoted value; multi-line values are not supported" };

  if (!/^\s*(#.*)?$/s.test(value.slice(end + 1)))
    return { error: "has text after the closing quote" };

  return { value: parsed };
}

/**
 * Dotenv text as NAME=VALUE pairs: blank lines and `#` comments skipped, an optional `export `
 * prefix, values as `envFileValue` reads them. Our own parser rather than node:util parseEnv,
 * which Node 20 before 20.12 lacks. Errors name `where` and the line, never a value.
 */
export function parseEnvFile(text: string, where: string) {
  const env: Record<string, string> = {};

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const split = assignment.indexOf("=");
    const name = split > 0 ? assignment.slice(0, split).trim() : "";

    if (!EnvName.test(name))
      throw usage(`${where}:${index + 1} must be NAME=VALUE with a valid NAME`);
    const parsed = envFileValue(assignment.slice(split + 1));

    if ("error" in parsed) throw usage(`${where}:${index + 1} ${parsed.error}`);
    env[name] = parsed.value;
  }

  return env;
}
