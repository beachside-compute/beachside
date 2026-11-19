import { Socket } from "node:net";
import { setImmediate as yieldOutput } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";
import {
  AdapterError,
  type AdapterSession,
  type ExecValue,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessStartContext,
  type ProcessStartInput,
  type ReadContext,
} from "@beachside/adapter";
import { MAX_OUTPUT_BYTES } from "./exec";
import { BoxHttpError, decodeBytes } from "./transport";

const FRAME_BYTES = 2 * 1024 * 1024;
const PENDING_BYTES = 2 * FRAME_BYTES;
const DELIVERY_BYTES = 16_384;
const INPUT_BYTES = 65_536;
const OUTGOING_BYTES = 262_144;

const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), pid: z.number().int().positive() }),
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("exit"), code: z.number().int().safe() }),
  z.object({ type: z.literal("error") }),
]);

// Bun's upgrade response can omit its socket. The pinned ws instance still retains the
// Node transport; access that field only to unref an abandoned connection.
const NativeSocket = z.object({ _socket: z.instanceof(Socket) });

type Stream = "stdout" | "stderr";

type Output = { stream: Stream; bytes: Buffer };

type Control =
  | { type: "stdin"; data: string }
  | { type: "stdin_close" }
  | { type: "signal"; signal: "TERM" | "KILL" }
  | { type: "resize"; rows: number; cols: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  void promise.catch(() => undefined);

  return { promise, resolve, reject };
}

type ProcessFactory = {
  processes: NonNullable<AdapterSession["processes"]>;
  close: () => void;
};

export function createProcesses(origin: string, apiKey: string): ProcessFactory {
  const sessions = new Set<() => void>();
  const url = origin.replace(/^http/, "ws");

  async function start(input: ProcessStartInput, ctx: ProcessStartContext): Promise<NativeProcess> {
    const setup = { deadline: ctx.deadline, signal: ctx.signal };
    const remaining = setup.deadline - Date.now();
    const byteOutput = input.output?.format === "bytes";
    let onBytes = ctx.onOutputBytes;
    let onText: ProcessStartContext["onOutput"] | undefined = ctx.onOutput;
    const captureLimit = input.capture?.maxBytes;

    if (byteOutput && !onBytes)
      throw new AdapterError("UNSUPPORTED", "Upstash Box byte output needs a byte consumer");

    if (
      captureLimit !== undefined &&
      (!Number.isSafeInteger(captureLimit) || captureLimit < 0 || captureLimit > MAX_OUTPUT_BYTES)
    )
      throw new AdapterError("CAPACITY", "Upstash Box process capture is outside its byte limit");

    if (setup.signal.aborted || remaining <= 0)
      throw new AdapterError("TIMEOUT", "Upstash Box process start expired before dispatch");

    const path = `/v2/box/${encodeURIComponent(input.sandbox.id)}/exec-session`;

    const socket = new WebSocket(url + path, {
      headers: { "X-Box-Api-Key": apiKey },
      followRedirects: false,
      maxPayload: FRAME_BYTES,
      perMessageDeflate: false,
      allowSynchronousEvents: false,
    });

    const started = deferred<NativeProcess>();
    const exited = deferred<NativeProcessExit>();
    const output = deferred<void>();
    const capture = captureLimit === undefined ? undefined : deferred<ExecValue>();

    let captured = capture && {
      stdout: Buffer.alloc(captureLimit ?? 0),
      stderr: Buffer.alloc(captureLimit ?? 0),
    };

    const lengths = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const queue: Output[] = [];
    let pendingBytes = 0;
    let delivering = false;
    let observing = true;
    let truncated = false;
    let dispatched = false;
    let acknowledged = false;
    let observedAt = new Date().toISOString();
    let finished = false;
    let detached = false;
    let confirmedExit: NativeProcessExit | undefined;
    let inputClosed = !input.terminal && input.stdin !== "pipe";
    let inputInFlight = false;
    let inputUncertain = false;

    function stopOutput(error: Error) {
      if (!observing) return;
      observing = false;
      onBytes = undefined;
      onText = undefined;
      queue.length = 0;
      pendingBytes = 0;
      socket.resume();
      output.reject(error);
    }

    function stopStartWait() {
      clearTimeout(timer);
      setup.signal.removeEventListener("abort", cancelStart);
    }

    function failed(error: Error) {
      if (finished) return;
      finished = true;
      stopStartWait();
      started.reject(error);
      exited.reject(error);
      capture?.reject(error);
      stopOutput(error);
      socket.terminate();
    }

    function abandon(error: AdapterError) {
      if (detached) return;
      detached = true;
      stopStartWait();
      stopOutput(error);
      started.reject(error);
      exited.reject(error);
      capture?.reject(error);
      captured = undefined;

      // Closing a dispatched session would stop its process. Drop local callbacks and
      // drain its socket until native exit, without keeping the host alive for the session.
      if (!dispatched) failed(error);
      else if (!finished) {
        const connection = NativeSocket.safeParse(socket);

        if (connection.success) connection.data._socket.unref();
      }
    }

    function detach() {
      abandon(new AdapterError("UNAVAILABLE", "Upstash Box process was detached"));
    }

    function cancelStart() {
      abandon(new AdapterError("TIMEOUT", "Upstash Box did not acknowledge process start in time"));
    }

    function checkControl(context: ReadContext) {
      if (context.signal.aborted || context.deadline <= Date.now())
        throw new AdapterError("TIMEOUT", "Upstash Box process input or control expired");

      if (finished || detached || socket.readyState !== WebSocket.OPEN)
        throw new AdapterError("UNAVAILABLE", "Upstash Box process connection is closed");

      if (socket.bufferedAmount > OUTGOING_BYTES)
        throw new AdapterError("CAPACITY", "Upstash Box process send buffer is full");
    }

    async function send(frame: Control, context: ReadContext) {
      checkControl(context);

      return new Promise<void>((resolve, reject) => {
        const complete = (error?: Error) => {
          clearTimeout(timeout);
          context.signal.removeEventListener("abort", abort);

          if (error) reject(error);
          else resolve();
        };

        const abort = () =>
          complete(new AdapterError("TIMEOUT", "Upstash Box process send was not confirmed"));

        const timeout = setTimeout(abort, Math.max(0, context.deadline - Date.now()));
        context.signal.addEventListener("abort", abort, { once: true });

        const failedSend = () => new AdapterError("UNAVAILABLE", "Upstash Box process send failed");

        try {
          socket.send(JSON.stringify(frame), (error) => complete(error ? failedSend() : undefined));
        } catch {
          complete(failedSend());
        }
      });
    }

    function checkInput(context: ReadContext) {
      checkControl(context);

      if (inputClosed || inputUncertain)
        throw new AdapterError("CONFLICT", "Upstash Box process input is closed or uncertain");

      if (inputInFlight)
        throw new AdapterError("CAPACITY", "Upstash Box process already has input pending");
    }

    async function sendInput(frame: Control, context: ReadContext) {
      checkInput(context);
      inputInFlight = true;

      try {
        await send(frame, context);

        if (frame.type === "stdin_close") inputClosed = true;
      } catch (error) {
        inputUncertain = true;
        throw error;
      } finally {
        inputInFlight = false;
      }
    }

    const handle: NativeProcess = {
      get confirmedExit() {
        return confirmedExit;
      },
      outputDone: output.promise,
      capture: capture?.promise,
      wait: () => exited.promise,
      async status() {
        if (confirmedExit) return { state: "exited", exit: confirmedExit, observedAt };

        return {
          state:
            acknowledged && !finished && !detached && socket.readyState === WebSocket.OPEN
              ? "running"
              : "unknown",
          observedAt,
        };
      },
      async detach() {
        detach();
      },
      async detachOutput() {
        stopOutput(new AdapterError("UNAVAILABLE", "Upstash Box process output was detached"));
      },
      async signal(signal, context) {
        if (signal !== "SIGTERM" && signal !== "SIGKILL")
          throw new AdapterError("INVALID_ARGUMENT", "Invalid Upstash Box process signal");

        if (confirmedExit) return { status: "not-found" };
        await send({ type: "signal", signal: signal === "SIGTERM" ? "TERM" : "KILL" }, context);

        return { status: "requested" };
      },
      ...(!inputClosed && {
        async write(bytes: Uint8Array, context: ReadContext) {
          if (bytes.length > INPUT_BYTES)
            throw new AdapterError("CAPACITY", "Upstash Box process write exceeds 64 KiB");

          if (!bytes.length) {
            checkInput(context);

            return;
          }

          await sendInput({ type: "stdin", data: Buffer.from(bytes).toString("base64") }, context);
        },
      }),
      ...(!input.terminal &&
        !inputClosed && {
          async closeStdin(context: ReadContext) {
            if (!inputClosed) await sendInput({ type: "stdin_close" }, context);
          },
        }),
      ...(input.terminal && {
        async resize({ rows, columns }: { rows: number; columns: number }, context: ReadContext) {
          await send({ type: "resize", rows, cols: columns }, context);
        },
      }),
    };

    async function deliver() {
      if (delivering || !observing) return;
      delivering = true;

      try {
        while (observing && queue.length) {
          const next = queue[0]!;

          for (let offset = 0; observing && offset < next.bytes.length; offset += DELIVERY_BYTES) {
            const bytes = next.bytes.subarray(offset, offset + DELIVERY_BYTES);

            if (byteOutput && onBytes)
              onBytes({ stream: next.stream, bytes: Uint8Array.from(bytes) });
            else {
              const value = decoders[next.stream].decode(bytes, { stream: true });

              if (value) onText?.({ stream: next.stream, text: value });
            }

            await yieldOutput();
          }

          if (!observing) return;
          queue.shift();
          pendingBytes -= next.bytes.length;

          if (socket.isPaused && pendingBytes < FRAME_BYTES) socket.resume();
        }

        if (confirmedExit && observing) {
          if (!byteOutput)
            for (const stream of ["stdout", "stderr"] as const) {
              const text = decoders[stream].decode();

              if (text) onText?.({ stream, text });
            }

          observing = false;
          onBytes = undefined;
          onText = undefined;
          output.resolve();
        }
      } catch (error) {
        stopOutput(
          error instanceof Error
            ? error
            : new AdapterError("UNAVAILABLE", "Upstash Box output consumer failed"),
        );
      } finally {
        delivering = false;
      }
    }

    function receive(stream: Stream, data: string) {
      if (!acknowledged) throw new AdapterError("UNAVAILABLE", "Upstash Box output preceded start");

      if (!observing && !captured) return;
      const bytes = decodeBytes(data, FRAME_BYTES);
      const channel = input.terminal ? "stdout" : stream;

      if (captured && captureLimit !== undefined) {
        const count = Math.min(bytes.length, captureLimit - lengths.stdout - lengths.stderr);
        bytes.copy(captured[channel], lengths[channel], 0, count);
        lengths[channel] += count;
        truncated ||= count < bytes.length;
      }

      if (!observing || !bytes.length) return;

      if (pendingBytes + bytes.length > PENDING_BYTES || queue.length >= 256) {
        stopOutput(new AdapterError("CAPACITY", "Upstash Box process output buffer is full"));

        return;
      }

      queue.push({ stream: channel, bytes });
      pendingBytes += bytes.length;

      if (pendingBytes >= FRAME_BYTES) socket.pause();
      void deliver();
    }

    function confirmExit(code: number) {
      if (!acknowledged) throw new AdapterError("UNAVAILABLE", "Upstash Box exit preceded start");
      finished = true;
      stopStartWait();

      if (detached) {
        socket.close();

        return;
      }

      confirmedExit = { exitCode: code };
      observedAt = new Date().toISOString();
      started.resolve(handle);
      exited.resolve(confirmedExit);

      if (captured)
        capture?.resolve({
          exitCode: code,
          stdout: captured.stdout.subarray(0, lengths.stdout),
          stderr: captured.stderr.subarray(0, lengths.stderr),
          truncated,
        });

      // The native exit is the final frame. Already received output can keep draining locally.
      socket.resume();
      socket.close();
      void deliver();
    }

    const timer = setTimeout(cancelStart, remaining);
    setup.signal.addEventListener("abort", cancelStart, { once: true });
    sessions.add(detach);
    socket.once("close", () => {
      sessions.delete(detach);
      failed(new AdapterError("UNAVAILABLE", "Upstash Box process closed without exit evidence"));
    });
    socket.on("error", () =>
      failed(new AdapterError("UNAVAILABLE", "Upstash Box process connection failed")),
    );
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      failed(new BoxHttpError(response.statusCode ?? 500));
    });
    socket.once("open", () => {
      if (finished) return;
      const cwd = input.cwd ?? "/workspace/home";

      const command =
        input.command.kind === "argv"
          ? { argv: input.command.argv }
          : { cmd: input.command.script };

      const frame = {
        type: "start",
        ...command,
        cwd: cwd.startsWith("/") ? cwd : `/workspace/home/${cwd}`,
        env: input.env && Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
        ...(input.terminal && {
          tty: true,
          rows: input.terminal.rows,
          cols: input.terminal.columns,
        }),
      };

      dispatched = true;
      socket.send(JSON.stringify(frame), (error) => {
        if (error) failed(new AdapterError("UNAVAILABLE", "Upstash Box process start send failed"));
      });
    });
    socket.on("message", (raw, binary) => {
      if (finished) return;

      try {
        if (binary || !Buffer.isBuffer(raw)) throw new Error("Invalid Upstash Box process frame");
        const frame = Frame.parse(JSON.parse(raw.toString("utf8")));

        if (detached && frame.type !== "started" && frame.type !== "exit") return;

        switch (frame.type) {
          case "started": {
            if (acknowledged) throw new Error("Duplicate Upstash Box process start");
            acknowledged = true;
            observedAt = new Date().toISOString();

            if (detached) {
              if (inputClosed)
                socket.send(JSON.stringify({ type: "stdin_close" }), () => undefined);

              break;
            }

            const ready = () => {
              stopStartWait();
              started.resolve(handle);
            };

            if (inputClosed)
              void send({ type: "stdin_close" }, setup).then(ready, (error) => {
                if (!detached) failed(error);
              });
            else ready();
            break;
          }

          case "stdout":
          case "stderr":
            receive(frame.type, frame.data);
            observedAt = new Date().toISOString();
            break;
          case "exit":
            confirmExit(frame.code);
            break;
          case "error":
            failed(new AdapterError("UNAVAILABLE", "Upstash Box process reported an error"));
            break;
        }
      } catch {
        if (!detached)
          failed(new AdapterError("UNAVAILABLE", "Upstash Box returned an invalid process frame"));
      }
    });

    return started.promise;
  }

  return {
    processes: {
      supports: {
        sustainedOutput: true,
        binaryOutput: true,
        signals: ["SIGTERM", "SIGKILL"],
        terminal: true,
        stdin: "bytes",
        execCapture: "bytes",
      },
      start,
    },
    close() {
      for (const detach of sessions) detach();
    },
  };
}
