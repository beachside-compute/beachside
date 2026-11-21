// Bundled dependencies (the @clack prompt packages) import `styleText` from node:util, which only
// exists from Node 20.12. The CLI supports Node 20, so the build routes their node:util imports
// here. A default import never fails to link; the fallback covers the ANSI formats they use.
import util from "node:util";

type Format = Parameters<typeof util.styleText>[0];

type Options = {
  validateStream?: boolean;
  stream?: NodeJS.WritableStream & { hasColors?: () => boolean };
};

const colors: Readonly<Record<string, readonly [number, number] | undefined>> = util.inspect.colors;

// Like native styleText, plain text unless the stream (stdout by default) is a color-capable TTY.
// tty.WriteStream#hasColors also honours NO_COLOR and FORCE_COLOR.
function colorable(options: Options | undefined): boolean {
  if (options?.validateStream === false) return true;

  const stream = options?.stream ?? process.stdout;

  return stream.hasColors?.() ?? false;
}

function fallbackStyleText(format: Format, text: string, options?: Options): string {
  const formats = Array.isArray(format) ? format : [format];
  let open = "";
  let close = "";

  for (const name of formats) {
    const codes = colors[String(name)];

    if (!codes) throw new TypeError(`Invalid style format: ${String(name)}`);
    open += `\u001b[${codes[0]}m`;
    close = `\u001b[${codes[1]}m${close}`;
  }

  return colorable(options) ? `${open}${text}${close}` : text;
}

// Absent before Node 20.12 even though the typings always declare it.
export const styleText: typeof util.styleText = util.styleText ?? fallbackStyleText;

export const stripVTControlCharacters = util.stripVTControlCharacters;
