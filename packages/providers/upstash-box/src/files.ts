import {
  AdapterError,
  AdapterFilesystemError,
  MAX_DIRECTORY_ENTRIES,
  MAX_DIRECTORY_NAME_BYTES,
  type AttemptContext,
  type FileEntry,
  type FileMutationInput,
  type FileStat,
  type FileTransferContext,
  type FileTransferInput,
  type FileWriteInput,
  type ReadContext,
  type Sandbox,
} from "@beachside/adapter";
import { z } from "zod";
import {
  APPEND_STAGE,
  COPY_STAGE,
  LINK_STAGE,
  REMOVE_EMPTY_DIRECTORY,
  guest,
  stagedFile,
  type GuestRunner,
} from "./files-shell";
import {
  BoxHttpError,
  decodeBytes,
  definitiveRefusal,
  RANGE_BYTES,
  type Transport,
} from "./transport";

export const MAX_FILE_BYTES = 1024 * 1024;

const StageName =
  /^\.beachside-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NativeStat = z.object({
  type: z.enum(["file", "directory", "symlink", "other"]),
  size: z.number().int().nonnegative().safe().optional(),
  mod_time: z.iso.datetime({ offset: true }).optional(),
  version: z.string().min(1).optional(),
});

type NativeStat = z.infer<typeof NativeStat>;

const NativeName = z
  .string()
  .min(1)
  .max(4096)
  .refine((name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0"));

const NativeDirectory = z.object({
  files: z.array(z.object({ name: NativeName })).nullable(),
});

const Content = z.object({ content: z.string() });

type PathInput = { sandbox: Sandbox; path: string };

type StreamWriteInput = PathInput & { overwrite: boolean; bytes: AsyncIterable<Uint8Array> };

type ReadableFile = { size: number; version: string };

export function boxPath(id: string) {
  return `/v2/box/${encodeURIComponent(id)}`;
}

function portableType(type: NativeStat["type"]): FileEntry["type"] {
  return type === "other" ? "unknown" : type;
}

function missing(error: Error) {
  return error instanceof BoxHttpError && error.status === 404;
}

export function boxFiles(
  transport: Transport,
  run: GuestRunner,
  identify: (sandbox: Sandbox) => string,
  guardGuest?: (sandbox: Sandbox, signal: AbortSignal) => Promise<void>,
) {
  const query = ({ sandbox, path }: PathInput) => ({
    prefix: `${boxPath(identify(sandbox))}/files`,
    path: encodeURIComponent(path),
  });

  async function guestRejection(sandbox: Sandbox, ctx: AttemptContext) {
    try {
      await guardGuest?.(sandbox, ctx.signal);
    } catch (error) {
      return error instanceof AdapterError
        ? ctx.reject(error.code, error.message)
        : ctx.reject("UNAVAILABLE", "Upstash Box guest readiness could not be checked");
    }
  }

  async function nativeStat(input: PathInput, signal: AbortSignal, follow: boolean) {
    const { prefix, path } = query(input);

    const result = NativeStat.safeParse(
      await transport.json(`${prefix}/stat?path=${path}${follow ? "&follow=true" : ""}`, signal),
    );

    if (!result.success)
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid file metadata");

    return result.data;
  }

  async function maybeStat(input: PathInput, signal: AbortSignal, follow = false) {
    try {
      return await nativeStat(input, signal, follow);
    } catch (error) {
      if (error instanceof Error && missing(error)) return null;
      throw error;
    }
  }

  async function requireDestinationParent(input: PathInput, signal: AbortSignal) {
    const path = input.path.slice(0, input.path.lastIndexOf("/")) || "/";
    const parent = await nativeStat({ sandbox: input.sandbox, path }, signal, true);

    if (parent.type !== "directory")
      throw new AdapterError("NOT_FOUND", "The destination parent is not a directory");
  }

  async function regular(input: PathInput, signal: AbortSignal): Promise<ReadableFile> {
    const file = await nativeStat(input, signal, true);

    if (file.type !== "file")
      throw new AdapterError("INVALID_ARGUMENT", "The path is not a regular file");

    if (file.size === undefined || file.version === undefined)
      throw new AdapterError("UNAVAILABLE", "Upstash Box did not report file size and version");

    return { size: file.size, version: file.version };
  }

  async function range(input: PathInput, offset: number, length: number, signal: AbortSignal) {
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

  async function verify(input: PathInput, file: ReadableFile, signal: AbortSignal) {
    const latest = await regular(input, signal);

    if (latest.version !== file.version || latest.size !== file.size)
      throw new AdapterError("CONFLICT", "Upstash Box file changed during reading");
  }

  async function list(input: PathInput, { signal }: ReadContext): Promise<FileEntry[]> {
    await guardGuest?.(input.sandbox, signal);
    const { prefix, path } = query(input);
    const directory = await nativeStat(input, signal, true);

    if (directory.type !== "directory")
      throw new AdapterError("INVALID_ARGUMENT", "The path is not a directory");

    const result = NativeDirectory.safeParse(
      await transport.json(`${prefix}/list?folder=${path}`, signal),
    );

    if (!result.success)
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned invalid directory data");

    const names = (result.data.files ?? []).map(({ name }) => name).sort();

    if (
      names.length > MAX_DIRECTORY_ENTRIES ||
      names.reduce((total, name) => total + Buffer.byteLength(name), 0) > MAX_DIRECTORY_NAME_BYTES
    )
      throw new AdapterError("CAPACITY", "Upstash Box directory exceeds the listing bound");

    if (new Set(names).size !== names.length)
      throw new AdapterError("UNAVAILABLE", "Upstash Box returned duplicate directory entries");

    // Native list only reports is_dir. Stat each listed name without following links, keeping
    // both the number of in-flight requests and the SDK's complete-directory result bounded.
    const entries: FileEntry[] = [];
    const parent = input.path.endsWith("/") ? input.path : `${input.path}/`;

    for (let index = 0; index < names.length; index += 16) {
      const batch = names.slice(index, index + 16);
      entries.push(
        ...(await Promise.all(
          batch.map(async (name) => {
            const item = await maybeStat({ sandbox: input.sandbox, path: parent + name }, signal);

            return { name, type: item ? portableType(item.type) : ("unknown" as const) };
          }),
        )),
      );
    }

    return entries;
  }

  async function writeNative(input: PathInput, bytes: Uint8Array, signal: AbortSignal) {
    await transport.empty(`${boxPath(identify(input.sandbox))}/files/write`, signal, "POST", {
      path: input.path,
      encoding: "base64",
      content: Buffer.from(bytes).toString("base64"),
    });
  }

  async function rename(sandbox: Sandbox, from: string, to: string, signal: AbortSignal) {
    await transport.empty(`${boxPath(identify(sandbox))}/files/rename`, signal, "POST", {
      from,
      to,
    });
  }

  async function publish(
    sandbox: Sandbox,
    stage: string,
    destination: string,
    overwrite: boolean,
    signal: AbortSignal,
  ) {
    if (overwrite) {
      try {
        await rename(sandbox, `${stage}/data`, destination, signal);
      } catch (error) {
        if (definitiveRefusal(error)) throw error;
        throw new Error("Upstash Box did not acknowledge file publication");
      }

      return;
    }

    const exit = await guest(run, sandbox, LINK_STAGE, [stage, destination], signal);

    if (exit === 73) throw new AdapterError("CONFLICT", "Upstash Box file already exists");

    if (exit === 74)
      throw new AdapterError(
        "UNSUPPORTED",
        "Upstash Box could not publish with exclusive hard linking",
      );

    if (exit !== 0) throw new Error("Upstash Box did not acknowledge exclusive file publication");
  }

  async function writeStream(input: StreamWriteInput, ctx: FileTransferContext) {
    identify(input.sandbox);

    if (input.path === "/" || input.path.endsWith("/"))
      throw new AdapterError("INVALID_ARGUMENT", "A file write requires a filename");
    await requireDestinationParent(input, ctx.signal);
    let bytesWritten = 0;

    await stagedFile(
      run,
      { sandbox: input.sandbox, destination: input.path },
      ctx,
      async (stage) => {
        const data = { sandbox: input.sandbox, path: `${stage}/data` };
        const chunk = { sandbox: input.sandbox, path: `${stage}/chunk` };
        await writeNative(data, new Uint8Array(), ctx.signal);
        // Reuse one private chunk and await the upload and append before reading more input.
        const buffer = new Uint8Array(MAX_FILE_BYTES);
        let buffered = 0;

        async function flush() {
          await writeNative(chunk, buffer.subarray(0, buffered), ctx.signal);

          if ((await guest(run, input.sandbox, APPEND_STAGE, [stage], ctx.signal)) !== 0)
            throw new AdapterError(
              "UNAVAILABLE",
              "Upstash Box did not confirm the staged file chunk",
            );
          bytesWritten += buffered;
          buffered = 0;
          ctx.retain?.({ bytesTransferred: bytesWritten });
        }

        for await (const bytes of input.bytes) {
          for (let offset = 0; offset < bytes.length;) {
            const count = Math.min(bytes.length - offset, buffer.length - buffered);
            buffer.set(bytes.subarray(offset, offset + count), buffered);
            buffered += count;
            offset += count;

            if (buffered === buffer.length) await flush();
          }
        }

        if (buffered) await flush();
        const staged = await nativeStat(data, ctx.signal, false);

        if (staged.type !== "file" || staged.size !== bytesWritten)
          throw new AdapterError(
            "UNAVAILABLE",
            "Upstash Box staged file length differs from the input",
          );
      },
      (stage) => publish(input.sandbox, stage, input.path, input.overwrite, ctx.signal),
    );

    return { bytesWritten };
  }

  return {
    maxBytes: MAX_FILE_BYTES,
    async read(input: PathInput & { maxBytes?: number }, { signal }: ReadContext) {
      await guardGuest?.(input.sandbox, signal);
      const file = await regular(input, signal);

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
    async readStream(input: PathInput, { signal }: ReadContext) {
      await guardGuest?.(input.sandbox, signal);
      const controller = new AbortController();
      const active = AbortSignal.any([signal, controller.signal]);
      const file = await regular(input, active);
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
    list,
    async readDirectory(input: PathInput, ctx: ReadContext) {
      return {
        entries: await list(input, ctx),
        completeness: "complete" as const,
        observedAt: new Date().toISOString(),
      };
    },
    async stat(
      input: PathInput & { followSymlinks: boolean },
      { signal }: ReadContext,
    ): Promise<FileStat> {
      await guardGuest?.(input.sandbox, signal);
      const file = await nativeStat(input, signal, input.followSymlinks);

      return {
        type: portableType(file.type),
        ...(file.size !== undefined && { sizeBytes: file.size }),
        ...(file.mod_time && { modifiedAt: file.mod_time }),
      };
    },
    async exists(input: PathInput, { signal }: ReadContext) {
      await guardGuest?.(input.sandbox, signal);

      return (await maybeStat(input, signal)) !== null;
    },
    makeDirectory: {
      async prepare(input: FileMutationInput, { signal }: ReadContext) {
        await guardGuest?.(input.sandbox, signal);
        const existing = await maybeStat(input, signal, true);

        if (existing && existing.type !== "directory")
          throw new AdapterError(
            "INVALID_ARGUMENT",
            "The directory path is occupied by a non-directory entry",
          );

        return input;
      },
      async submit(input: FileMutationInput, ctx: AttemptContext) {
        const { sandbox, path, recursive } = input;
        const id = identify(sandbox);

        try {
          await transport.empty(`${boxPath(id)}/files/mkdir`, ctx.signal, "POST", {
            path,
            parents: recursive,
          });
        } catch (error) {
          if (!(error instanceof BoxHttpError) || ![400, 404, 409, 422].includes(error.status)) {
            if (definitiveRefusal(error)) return ctx.reject(error.code, error.message);

            return ctx.unknown("Upstash Box did not acknowledge directory creation");
          }

          const existing = await maybeStat(input, ctx.signal, true).catch(() => null);

          if (existing?.type !== "directory") return ctx.reject(error.code, error.message);
        }

        return { acknowledged: true as const };
      },
    },
    async remove(input: FileMutationInput, ctx: AttemptContext) {
      const { sandbox, path, recursive } = input;
      const id = identify(sandbox);

      if (path === "/") return ctx.reject("INVALID_ARGUMENT", "Cannot remove the filesystem root");
      const rejected = await guestRejection(sandbox, ctx);

      if (rejected) return rejected;

      try {
        const file = await maybeStat(input, ctx.signal);

        if (!file) return { acknowledged: true as const };

        if (!recursive && file.type === "directory") {
          const exit = await guest(run, sandbox, REMOVE_EMPTY_DIRECTORY, [path], ctx.signal);

          if (exit === null)
            return ctx.unknown("Upstash Box did not acknowledge directory removal");

          if (exit !== 0 && (await maybeStat(input, ctx.signal)))
            return ctx.reject(
              "CONFLICT",
              "Upstash Box could not remove the directory without recursion",
            );
        } else {
          await transport.empty(`${boxPath(id)}/files/remove`, ctx.signal, "POST", {
            path,
            recursive,
          });
        }
      } catch (error) {
        if (definitiveRefusal(error) && error.status !== 404)
          return ctx.reject(error.code, error.message);

        if (!(error instanceof Error && missing(error)))
          return ctx.unknown("Upstash Box did not acknowledge file removal");
      }

      return { acknowledged: true as const };
    },
    async write(input: FileWriteInput, ctx: AttemptContext) {
      identify(input.sandbox);

      if (input.path === "/" || input.path.endsWith("/"))
        return ctx.reject("INVALID_ARGUMENT", "A file write requires a filename");

      if (input.bytes.byteLength > MAX_FILE_BYTES)
        return ctx.reject("CAPACITY", "Upstash Box write exceeds the buffered limit");
      const rejected = await guestRejection(input.sandbox, ctx);

      if (rejected) return rejected;

      try {
        if (input.overwrite) {
          await requireDestinationParent(input, ctx.signal);
          await writeNative(input, input.bytes, ctx.signal);
        } else {
          const bytes = input.bytes;
          await writeStream(
            {
              ...input,
              bytes: (async function* () {
                yield bytes;
              })(),
            },
            {
              signal: ctx.signal,
              deadline: Date.now() + 30_000,
            },
          );
        }

        return { bytesWritten: input.bytes.byteLength };
      } catch (error) {
        if (error instanceof AdapterFilesystemError) {
          if (error.details.effect === "applied") return { bytesWritten: input.bytes.byteLength };
          const path = error.details.temporaryPaths?.[0];
          const stage = path?.slice(path.lastIndexOf("/") + 1);

          if (stage && StageName.test(stage))
            return ctx.unknown(
              `Upstash Box could not confirm the file write; staging directory ${stage} may remain beside the destination`,
            );
        }

        if (
          definitiveRefusal(error) ||
          (error instanceof AdapterError &&
            !(error instanceof AdapterFilesystemError) &&
            [
              "INVALID_ARGUMENT",
              "NOT_FOUND",
              "CONFLICT",
              "UNSUPPORTED",
              "UNAUTHENTICATED",
              "FORBIDDEN",
            ].includes(error.code))
        )
          return ctx.reject(error.code, error.message);

        return ctx.unknown("Upstash Box could not confirm the file write");
      }
    },
    async writeStream(input: StreamWriteInput, ctx: FileTransferContext) {
      await guardGuest?.(input.sandbox, ctx.signal);

      return writeStream(input, ctx);
    },
    async copy(input: FileTransferInput, ctx: FileTransferContext) {
      await guardGuest?.(input.sandbox, ctx.signal);

      const source = await nativeStat(
        { sandbox: input.sandbox, path: input.source },
        ctx.signal,
        false,
      );

      if (source.type !== "file")
        throw new AdapterError("INVALID_ARGUMENT", "Only regular files can be copied");
      await requireDestinationParent(
        { sandbox: input.sandbox, path: input.destination },
        ctx.signal,
      );

      await stagedFile(
        run,
        input,
        ctx,
        async (stage) => {
          const exit = await guest(
            run,
            input.sandbox,
            COPY_STAGE,
            [input.source, stage],
            ctx.signal,
          );

          if (exit !== 0)
            throw new AdapterError(
              "CONFLICT",
              "Upstash Box could not copy the regular source file",
            );
        },
        (stage) => publish(input.sandbox, stage, input.destination, input.overwrite, ctx.signal),
      );

      return { acknowledged: true as const };
    },
    async move(input: FileTransferInput, ctx: FileTransferContext) {
      identify(input.sandbox);

      if (!input.overwrite)
        throw new AdapterError("UNSUPPORTED", "Upstash Box has no atomic no-clobber rename");
      await guardGuest?.(input.sandbox, ctx.signal);

      try {
        await rename(input.sandbox, input.source, input.destination, ctx.signal);
      } catch (error) {
        if (definitiveRefusal(error)) throw error;
        throw new AdapterFilesystemError(
          "UNAVAILABLE",
          "Upstash Box did not acknowledge the rename",
          {
            effect: "unknown",
            source: input.source,
            destination: input.destination,
          },
        );
      }

      return { acknowledged: true as const };
    },
  };
}
