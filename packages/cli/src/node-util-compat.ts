// Bundled dependencies (the @clack prompt packages) import `styleText` from node:util, which only
// exists from Node 20.12. The CLI supports Node 20, so the build routes their node:util imports
// here. A default import never fails to link; the fallback covers the ANSI formats they use.
import util from "node:util";

type Format = Parameters<typeof util.styleText>[0];

const colors: Readonly<Record<string, readonly [number, number] | undefined>> = util.inspect.colors;

function fallbackStyleText(format: Format, text: string): string {
  const formats = Array.isArray(format) ? format : [format];
  let open = "";
  let close = "";

  for (const name of formats) {
    const codes = colors[String(name)];

    if (!codes) throw new TypeError(`Invalid style format: ${String(name)}`);
    open += `\u001b[${codes[0]}m`;
    close = `\u001b[${codes[1]}m${close}`;
  }

  return `${open}${text}${close}`;
}

// Absent before Node 20.12 even though the typings always declare it.
export const styleText: typeof util.styleText = util.styleText ?? fallbackStyleText;

export const stripVTControlCharacters = util.stripVTControlCharacters;
