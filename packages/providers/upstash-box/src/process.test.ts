import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { setImmediate as yieldEvents } from "node:timers/promises";
import type { ProcessOutput, ProcessOutputBytes } from "@beachside/adapter";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { createProcesses } from "./process";

const ClientFrame = z.object({
  type: z.string(),
  data: z.string().optional(),
  signal: z.string().optional(),
  rows: z.number().optional(),
  cols: z.number().optional(),
  tty: z.boolean().optional(),
  argv: z.array(z.string()).optional(),
});

const disposals: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});

type ServerFrame =
  | { type: "started"; pid: number }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; code: number };

function send(socket: WebSocket, value: ServerFrame) {
  socket.send(JSON.stringify(value));
}

function context() {
  return { deadline: Date.now() + 5000, signal: AbortSignal.timeout(5000) };
}

async function fixture(receive: (frame: z.infer<typeof ClientFrame>, socket: WebSocket) => void) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const frames: z.infer<typeof ClientFrame>[] = [];
  server.on("connection", (socket, request) => {
    expect(request.url).toBe("/v2/box/box_fixture/exec-session");
    expect(request.headers["x-box-api-key"]).toBe("fixture");
    socket.on("message", (raw) => {
      const frame = ClientFrame.parse(JSON.parse(raw.toString()));
      frames.push(frame);
      receive(frame, socket);
    });
  });
  disposals.push(
    () =>
      new Promise((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  await once(server, "listening");
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const factory = createProcesses(`http://127.0.0.1:${port}`, "fixture");
  disposals.push(async () => factory.close());

  return { ...factory, frames };
}

const command = { kind: "argv", argv: ["cat", ""] } as const;

test("process streams exact output, writes binary input and closes the pipe once", async () => {
  const wire = await fixture((frame, socket) => {
    if (frame.type === "start") {
      send(socket, { type: "started", pid: 1 });
      send(socket, { type: "stdout", data: Buffer.from([0x00, 0xff]).toString("base64") });
    }

    if (frame.type === "stdin_close") {
      send(socket, { type: "stderr", data: Buffer.from([0x81]).toString("base64") });
      send(socket, { type: "exit", code: 7 });
    }
  });

  const chunks: ProcessOutputBytes[] = [];

  const process = await wire.processes.start(
    {
      sandbox: { id: "box_fixture" },
      command: { kind: command.kind, argv: [...command.argv] },
      stdin: "pipe",
      output: { mode: "stream", format: "bytes" },
      maxOutputBytes: 1024,
    },
    { ...context(), onOutput() {}, onOutputBytes: (chunk) => chunks.push(chunk) },
  );

  expect(await process.status!(context())).toMatchObject({ state: "running" });
  await process.write!(Uint8Array.of(0, 255), context());
  await process.write!(Uint8Array.of(128), context());
  const eof = process.closeStdin!(context());
  await eof;
  await process.closeStdin!(context());
  expect(await process.wait()).toEqual({ exitCode: 7 });
  expect(await process.status!(context())).toMatchObject({
    state: "exited",
    exit: { exitCode: 7 },
  });
  await process.outputDone;
  expect(chunks).toEqual([
    { stream: "stdout", bytes: Uint8Array.of(0, 255) },
    { stream: "stderr", bytes: Uint8Array.of(129) },
  ]);
  expect(wire.frames).toEqual([
    { type: "start", argv: ["cat", ""] },
    { type: "stdin", data: "AP8=" },
    { type: "stdin", data: "gA==" },
    { type: "stdin_close" },
  ]);
});

test("terminal sends initial size, resize and single-signal controls without pipe EOF", async () => {
  const wire = await fixture((frame, socket) => {
    if (frame.type === "start") send(socket, { type: "started", pid: 1 });

    if (frame.type === "signal" && frame.signal === "KILL")
      send(socket, { type: "exit", code: 137 });
  });

  const process = await wire.processes.start(
    {
      sandbox: { id: "box_fixture" },
      command: { kind: "shell", script: "cat" },
      terminal: { rows: 20, columns: 40 },
      stdin: "pipe",
      output: { mode: "stream", format: "bytes" },
      maxOutputBytes: 1024,
    },
    { ...context(), onOutput() {}, onOutputBytes() {} },
  );

  expect(process.closeStdin).toBeUndefined();
  await process.write!(Uint8Array.of(3), context());
  await process.resize!({ rows: 25, columns: 80 }, context());
  await process.detachOutput!();
  expect(await process.signal!("SIGTERM", context())).toEqual({ status: "requested" });
  expect(await process.signal!("SIGKILL", context())).toEqual({ status: "requested" });
  expect(await process.wait()).toEqual({ exitCode: 137 });
  expect(wire.frames).toEqual([
    { type: "start", tty: true, rows: 20, cols: 40 },
    { type: "stdin", data: "Aw==" },
    { type: "resize", rows: 25, cols: 80 },
    { type: "signal", signal: "TERM" },
    { type: "signal", signal: "KILL" },
  ]);
});

test("text decoding crosses frames and bounded capture retains native bytes", async () => {
  const wire = await fixture((frame, socket) => {
    if (frame.type === "start") send(socket, { type: "started", pid: 1 });

    if (frame.type === "stdin_close") {
      send(socket, { type: "stdout", data: "ww==" });
      send(socket, { type: "stdout", data: "qQ==" });
      send(socket, { type: "stderr", data: "AP8=" });
      send(socket, { type: "exit", code: 0 });
    }
  });

  const chunks: ProcessOutput[] = [];

  const process = await wire.processes.start(
    {
      sandbox: { id: "box_fixture" },
      command: { kind: "shell", script: "cat" },
      capture: { maxBytes: 3 },
      maxOutputBytes: 1024,
    },
    { ...context(), onOutput: (chunk) => chunks.push(chunk) },
  );

  await process.outputDone;
  expect(chunks).toEqual([
    { stream: "stdout", text: "é" },
    { stream: "stderr", text: "\u0000�" },
  ]);
  const capture = await process.capture;

  if (!(capture?.stdout instanceof Uint8Array && capture.stderr instanceof Uint8Array))
    throw new Error("Expected bounded original-byte capture");
  expect(capture.exitCode).toBe(0);
  expect(Uint8Array.from(capture.stdout)).toEqual(Uint8Array.of(0xc3, 0xa9));
  expect(Uint8Array.from(capture.stderr)).toEqual(Uint8Array.of(0));
  expect(capture.truncated).toBe(true);
});

test("full detach disposes observation without issuing a signal or inventing exit", async () => {
  let native: WebSocket | undefined;

  const wire = await fixture((frame, socket) => {
    if (frame.type === "start") {
      native = socket;
      send(socket, { type: "started", pid: 1 });
    }
  });

  let output = 0;

  const process = await wire.processes.start(
    {
      sandbox: { id: "box_fixture" },
      command: { kind: "shell", script: "cat" },
      stdin: "pipe",
      maxOutputBytes: 1024,
    },
    { ...context(), onOutput: () => output++ },
  );

  await process.detach();
  await process.detach();
  wire.close();
  await expect(process.wait()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await yieldEvents();

  if (!native) throw new Error("Expected a native process session");
  expect(native.readyState).toBe(native.OPEN);
  send(native, { type: "stdout", data: "YQ==" });
  const closed = once(native, "close");
  send(native, { type: "exit", code: 0 });
  await closed;
  expect(output).toBe(0);
  expect(process.confirmedExit).toBeUndefined();
  expect(wire.frames).toEqual([{ type: "start" }]);
});

test("sustained output delivers multiple large frames in bounded chunks", async () => {
  const size = 768 * 1024;
  const data = Buffer.alloc(size, 0xfb).toString("base64");

  const wire = await fixture((frame, socket) => {
    if (frame.type === "start") send(socket, { type: "started", pid: 1 });

    if (frame.type === "stdin_close") {
      send(socket, { type: "stdout", data });
      send(socket, { type: "stderr", data });
      send(socket, { type: "exit", code: 0 });
    }
  });

  const lengths = { stdout: 0, stderr: 0 };

  const process = await wire.processes.start(
    {
      sandbox: { id: "box_fixture" },
      command: { kind: "shell", script: "printf" },
      output: { mode: "stream", format: "bytes" },
      maxOutputBytes: 1024,
    },
    {
      ...context(),
      onOutput() {},
      onOutputBytes({ stream, bytes }) {
        expect(bytes.length).toBeLessThanOrEqual(16_384);
        expect(bytes[0]).toBe(0xfb);
        lengths[stream] += bytes.length;
      },
    },
  );

  expect(await process.wait()).toEqual({ exitCode: 0 });
  await process.outputDone;
  expect(lengths).toEqual({ stdout: size, stderr: size });
});
