import WebSocket from "ws";
import { AdapterError, type ExecInput, type ExecValue } from "@beachside/adapter";
import { z } from "zod";
import { BoxHttpError, decodeBytes } from "./transport";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const FRAME_BYTES = 2 * 1024 * 1024;

const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started"), pid: z.number().int().positive() }),
  z.object({ type: z.literal("stdout"), data: z.string() }),
  z.object({ type: z.literal("stderr"), data: z.string() }),
  z.object({ type: z.literal("exit"), code: z.number().int().safe() }),
  z.object({ type: z.literal("error") }),
]);

type ClientFrame =
  | { type: "start"; argv?: string[]; cmd?: string; cwd: string; env?: string[] }
  | { type: "stdin"; data: string }
  | { type: "stdin_close" };

export class ExecLoss extends Error {
  constructor(readonly output: ExecValue) {
    super("Upstash Box did not confirm command completion");
  }
}

export function createExec(origin: string, apiKey: string) {
  const sockets = new Set<WebSocket>();
  const url = origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

  function close() {
    for (const socket of sockets) socket.terminate();
  }

  function exec(input: ExecInput, signal: AbortSignal): Promise<ExecValue> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AdapterError("TIMEOUT", "Upstash Box command was not started"));

        return;
      }

      const path = `/v2/box/${encodeURIComponent(input.sandbox.id)}/exec-session`;

      const socket = new WebSocket(url + path, {
        headers: { "X-Box-Api-Key": apiKey },
        followRedirects: false,
        maxPayload: FRAME_BYTES,
        perMessageDeflate: false,
      });

      sockets.add(socket);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let sent = false;
      let started = false;
      let settled = false;
      let captured = 0;
      let truncated = false;
      const max = input.maxOutputBytes;

      function result(exitCode: number | null): ExecValue {
        return {
          exitCode,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          truncated,
        };
      }

      function finish(value: ExecValue | Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);

        if (value instanceof Error) reject(value);
        else resolve(value);

        if (socket.readyState === WebSocket.OPEN) socket.close();
        else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      }

      function loss() {
        finish(
          sent
            ? new ExecLoss(result(null))
            : new AdapterError("UNAVAILABLE", "Upstash Box could not start a live session"),
        );
      }

      function stop() {
        if (sent && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "terminate" }), () => undefined);
        }

        loss();
      }

      function send(frame: ClientFrame, callback?: () => void) {
        socket.send(JSON.stringify(frame), (error) => {
          if (error) loss();
          else if (!settled) callback?.();
        });
      }

      let offset = 0;

      function sendInput() {
        const bytes = input.stdin;

        if (!bytes || offset === bytes.length) {
          send({ type: "stdin_close" });

          return;
        }

        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        offset += chunk.length;
        send({ type: "stdin", data: Buffer.from(chunk).toString("base64") }, sendInput);
      }

      const timer = setTimeout(stop, Math.min(input.deadlineSeconds * 1000, 2_147_483_647));
      signal.addEventListener("abort", stop, { once: true });
      socket.once("close", () => {
        sockets.delete(socket);
        loss();
      });
      socket.on("error", loss);
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        finish(new BoxHttpError(response.statusCode ?? 500));
      });
      socket.once("open", () => {
        const command =
          input.command.kind === "argv"
            ? { argv: input.command.argv }
            : { cmd: input.command.script };

        const cwd = input.cwd ?? "/workspace/home";
        sent = true;
        send({
          type: "start",
          ...command,
          cwd: cwd.startsWith("/") ? cwd : `/workspace/home/${cwd}`,
          env: input.env && Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
        });
      });
      socket.on("message", (raw, binary) => {
        if (settled) return;

        try {
          if (binary || !Buffer.isBuffer(raw)) return loss();
          const frame = ServerFrame.parse(JSON.parse(raw.toString("utf8")));

          switch (frame.type) {
            case "started":
              if (started) return loss();
              started = true;
              sendInput();
              break;
            case "stdout":
            case "stderr": {
              if (!started) return loss();
              const bytes = decodeBytes(frame.data, FRAME_BYTES);
              const keep = Math.min(bytes.length, max - captured);

              if (keep > 0) {
                const stream = frame.type === "stdout" ? stdout : stderr;
                stream.push(Buffer.from(bytes.subarray(0, keep)));
                captured += keep;
              }

              truncated ||= keep < bytes.length;
              break;
            }

            case "exit":
              if (!started) return loss();
              finish(result(frame.code));
              break;
            case "error":
              loss();
              break;
          }
        } catch {
          loss();
        }
      });
    });
  }

  return { exec, close };
}
