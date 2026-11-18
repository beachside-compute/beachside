import { AdapterError, type ReadContext, type Sandbox } from "@beachside/adapter";
import { z } from "zod";
import { decodeBytes, RANGE_BYTES, type Transport } from "./transport";

export const MAX_FILE_BYTES = 1024 * 1024;

const File = z.object({
  type: z.literal("file"),
  size: z.number().int().nonnegative().safe(),
  version: z.string().min(1),
});

const Content = z.object({ content: z.string() });

// Exit 73 is reserved for EEXIST from the exclusive open, before any bytes are written.
export const EXCLUSIVE_WRITE = `
const fs = require("node:fs");
const input = fs.readFileSync(0);
if (input.length !== Number(process.argv[2])) process.exit(74);
let fd;
try {
  fd = fs.openSync(process.argv[1], "wx");
} catch (error) {
  process.exit(error.code === "EEXIST" ? 73 : 74);
}
let offset = 0;
while (offset < input.length) {
  const count = fs.writeSync(fd, input, offset, input.length - offset);
  if (count === 0) throw new Error("incomplete write");
  offset += count;
}
fs.closeSync(fd);
`;

export function boxPath(id: string) {
  return `/v2/box/${encodeURIComponent(id)}`;
}

export function boxFiles(transport: Transport) {
  const query = ({ sandbox, path }: { sandbox: Sandbox; path: string }) => ({
    prefix: `${boxPath(sandbox.id)}/files`,
    path: encodeURIComponent(path),
  });

  async function stat(input: { sandbox: Sandbox; path: string }, signal: AbortSignal) {
    const { prefix, path } = query(input);

    const result = File.safeParse(
      await transport.json(`${prefix}/stat?path=${path}&follow=true`, signal),
    );

    if (!result.success)
      throw new AdapterError("UNAVAILABLE", "Upstash Box did not report regular file metadata");

    return result.data;
  }

  async function range(
    input: { sandbox: Sandbox; path: string },
    offset: number,
    length: number,
    signal: AbortSignal,
  ) {
    const { prefix, path } = query(input);

    const result = Content.safeParse(
      await transport.json(
        `${prefix}/read?path=${path}&encoding=base64&offset=${offset}&length=${length}`,
        signal,
      ),
    );

    if (!result.success)
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid file data");
    const bytes = decodeBytes(result.data.content, length);

    if (bytes.length !== length)
      throw new AdapterError("CONFLICT", "Upstash Box file changed during reading");

    return bytes;
  }

  async function verify(
    input: { sandbox: Sandbox; path: string },
    file: z.infer<typeof File>,
    signal: AbortSignal,
  ) {
    const latest = await stat(input, signal);

    if (latest.version !== file.version || latest.size !== file.size)
      throw new AdapterError("CONFLICT", "Upstash Box file changed during reading");
  }

  return {
    maxBytes: MAX_FILE_BYTES,
    async read(
      input: { sandbox: Sandbox; path: string; maxBytes?: number },
      { signal }: ReadContext,
    ) {
      const file = await stat(input, signal);

      // Let the SDK detect one extra byte and route adapter-limit reads to readStream.
      const length = Math.min(
        file.size,
        (input.maxBytes ?? MAX_FILE_BYTES) + 1,
        MAX_FILE_BYTES + 1,
      );

      const bytes = length === 0 ? new Uint8Array() : await range(input, 0, length, signal);
      await verify(input, file, signal);

      return bytes;
    },
    async readStream(input: { sandbox: Sandbox; path: string }, { signal }: ReadContext) {
      const controller = new AbortController();
      const active = AbortSignal.any([signal, controller.signal]);
      const file = await stat(input, active);
      let offset = 0;

      return new ReadableStream<Uint8Array>(
        {
          async pull(stream) {
            if (offset === file.size) {
              await verify(input, file, active);
              stream.close();

              return;
            }

            const length = Math.min(RANGE_BYTES, file.size - offset);
            const bytes = await range(input, offset, length, active);
            offset += bytes.length;
            stream.enqueue(bytes);
          },
          cancel() {
            controller.abort();
          },
        },
        { highWaterMark: 0 },
      );
    },
  };
}
