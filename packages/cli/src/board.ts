import { spawn } from "node:child_process";
import { z } from "zod";
import type { Flags } from "./commands";
import { CliError, registerSecret, usage } from "./output";
import type { Session } from "./session";
import type { SandboxBoardRecord, SandboxRecord } from "./store";
import { parseDuration } from "./units";

/**
 * `beachside board ...` and `create --board` drive the standalone `beachbar` command, so boards,
 * tokens and the owner's config stay in one place: `~/.config/beachbar/config.json`.
 */
const install =
  "install it with `npm install -g @beachside/beachbar`, or set BEACHSIDE_BEACHBAR to its path";

/** beachbar's board-management words; `beachside board create x` is `beachbar board create x`. */
const boardActions = ["create", "ls", "show", "use", "archive", "rm", "set", "guard"] as const;

/** beachbar's global flags that take a value, which may come before the command word. */
const valueFlags = new Set(["--board", "--sub", "--server"]);

/** beachbar's limits on names and token lifetimes, checked here so a refusal is a usage error. */
const agentName = /^[a-z0-9][a-z0-9._-]{0,47}$/;

const boardName = /^[a-z0-9][a-z0-9-]{0,47}$/;

const minTtlSeconds = 60;

const maxTtlSeconds = 366 * 86_400;

/** Roles a sandbox token may have. The owner token stays on the machine that made the board. */
export const boardRoles = ["worker", "lead", "observer"] as const;

/** Variables `create --board` sets in the sandbox environment. */
export const boardEnv = ["BEACHBAR_URL", "BEACHBAR_TOKEN"] as const;

const defaultTtlSeconds = 7 * 86_400;

export type BoardRequest = {
  board: string;
  role: (typeof boardRoles)[number];
  /** The token's identity on the board; the sandbox name unless --board-agent names one. */
  agent?: string;
  ttlSeconds: number;
};

/** `--board`, `--board-role`, `--board-agent`, `--board-ttl` from create, or null without --board. */
export function boardRequest(
  flags: Flags,
  lifetimeSeconds: number | undefined,
): BoardRequest | null {
  const board = flags.string("board");
  const related = ["board-role", "board-agent", "board-ttl"].find((name) => flags.has(name));

  if (board === undefined) {
    if (related) throw usage(`--${related} needs --board <name>`);

    return null;
  }

  if (!board) throw usage("--board needs a board name from `beachside board ls`");

  if (!boardName.test(board))
    throw usage("--board takes a board name: 1-48 lowercase letters, digits or '-'");
  const role = flags.string("board-role") ?? "worker";

  if (!boardRoles.some((entry) => entry === role))
    throw usage(
      `--board-role ${role} is not a sandbox role`,
      `use one of ${boardRoles.join(", ")}; the owner token never goes into a sandbox`,
    );
  const agent = flags.string("board-agent");

  if (agent !== undefined && !agentName.test(agent))
    throw usage("--board-agent takes 1-48 lowercase letters, digits, '.', '_' or '-'");
  const ttl = flags.string("board-ttl");

  // A token outlives its sandbox only by accident, so it follows the sandbox's own lifetime.
  const ttlSeconds =
    ttl === undefined ? (lifetimeSeconds ?? defaultTtlSeconds) : parseDuration(ttl, "board-ttl");

  if (ttlSeconds < minTtlSeconds || ttlSeconds > maxTtlSeconds)
    throw usage(
      `${ttl === undefined ? "--ttl" : "--board-ttl"} must be between 60s and 366d for a board token`,
      ttl === undefined
        ? "pass --board-ttl 60s or longer; a board token cannot be shorter than a minute"
        : "pick a duration from 60s to 366d",
    );

  return {
    board,
    role: z.enum(boardRoles).parse(role),
    ...(agent !== undefined && { agent }),
    ttlSeconds,
  };
}

type Ran = { code: number; stdout: string; stderr: string };

function beachbarPath(session: Session): string {
  return session.ctx.env.BEACHSIDE_BEACHBAR || "beachbar";
}

function missing(): CliError {
  return new CliError(
    "BEACHBAR_NOT_INSTALLED",
    "Cannot run beachbar, which `beachside board` and `create --board` use",
    install,
  );
}

/** Run beachbar with its output captured, for the JSON it prints. */
function capture(session: Session, args: string[]): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(beachbarPath(session), args, {
      env: { ...session.ctx.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (cause) =>
      fail("code" in cause && cause.code === "ENOENT" ? missing() : cause),
    );
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

const Failure = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    reason: z.string(),
    message: z.string(),
    next: z.array(z.string()),
  }),
});

type BeachbarFailure = z.infer<typeof Failure>["error"];

/** beachbar's error codes as Beachside's, so exit codes and `--retry` mean the same thing. */
const codes = new Map([
  ["UNAUTHORIZED", "UNAUTHENTICATED"],
  ["NOT_FOUND", "NOT_FOUND"],
  ["FORBIDDEN", "FORBIDDEN"],
  ["RATE_LIMITED", "RATE_LIMIT"],
  ["UNAVAILABLE", "UNAVAILABLE"],
  ["INVALID", "INVALID_ARGUMENT"],
  ["CONFLICT", "CONFLICT"],
]);

/** beachbar's JSON error, or null when stdout is not one (a crash, or another version). */
function failureOf(ran: Ran): BeachbarFailure | null {
  try {
    const parsed = Failure.safeParse(JSON.parse(ran.stdout.trim() || "null"));

    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

/** beachbar's error, as a Beachside error with its first hint. */
function failed(ran: Ran, what: string): CliError {
  const error = failureOf(ran);

  if (error === null)
    return new CliError(
      "BEACHBAR_FAILED",
      `${what} failed: ${ran.stderr.trim().split("\n")[0] || `exit ${ran.code}`}`,
    );

  const code = codes.get(error.code) ?? "BEACHBAR_FAILED";

  return new CliError(
    code,
    `${what}: ${error.message}`,
    error.next[0],
    undefined,
    "rejected",
    undefined,
    code === "RATE_LIMIT" || code === "UNAVAILABLE",
  );
}

const Minted = z.object({
  ok: z.literal(true),
  data: z.object({
    id: z.string(),
    agent: z.string(),
    role: z.string(),
    token: z.string().min(1),
    url: z.string().url(),
    expiresAt: z.number().int().nullable(),
  }),
});

export type AcquiredBoardToken = {
  env: Record<(typeof boardEnv)[number], string>;
  record: SandboxBoardRecord;
};

/** Mint a board token for a sandbox, before the sandbox exists. */
export async function mintBoardToken(
  session: Session,
  request: BoardRequest,
  sandbox: string,
): Promise<AcquiredBoardToken> {
  const agent = request.agent ?? sandbox;

  if (!agentName.test(agent))
    throw usage(
      `${sandbox} is not a beachbar agent name (1-48 lowercase letters, digits, '.', '_' or '-')`,
      "name the sandbox's identity on the board with --board-agent <name>",
    );

  const ran = await capture(session, [
    "--json",
    "token",
    "mint",
    agent,
    "--board",
    request.board,
    "--role",
    request.role,
    "--ttl",
    `${request.ttlSeconds}s`,
  ]);

  // Whatever beachbar printed may hold the token; redact it before anything can echo it.
  for (const secret of ran.stdout.match(/bbr_[A-Za-z0-9_-]+/g) ?? []) registerSecret(secret);

  if (ran.code !== 0) throw failed(ran, `minting a token on board ${request.board}`);

  const minted = parseMinted(ran.stdout);

  if (minted === null)
    throw new CliError(
      "BEACHBAR_FAILED",
      `beachbar minted a token on board ${request.board} but its answer was not understood`,
      `the token may be live: list it with \`beachside board token ls --board ${request.board}\` and revoke it with \`beachside board token revoke <id> --board ${request.board}\``,
      undefined,
      "unknown",
    );

  const { token, url, id, expiresAt, role } = minted;

  // The token is a credential: nothing the CLI prints may carry it.
  registerSecret(token);

  return {
    env: { BEACHBAR_URL: url, BEACHBAR_TOKEN: token },
    record: {
      board: request.board,
      url,
      tokenId: id,
      agent: minted.agent,
      role,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    },
  };
}

type MintedToken = z.infer<typeof Minted>["data"];

function parseMinted(stdout: string): MintedToken | null {
  try {
    const parsed = Minted.safeParse(JSON.parse(stdout));

    return parsed.success ? parsed.data.data : null;
  } catch {
    return null;
  }
}

const BoardStatus = z.object({
  ok: z.literal(true),
  data: z.object({ board: z.object({ id: z.string() }) }),
});

/**
 * Revoke a token by id on the board that issued it. The saved board must still be that board (a
 * re-created board under the same name is another board); a token the board no longer knows counts
 * as revoked. Anything else is an error, never a silent success.
 */
export async function revokeBoardToken(
  session: Session,
  record: SandboxBoardRecord,
): Promise<void> {
  const status = await capture(session, ["--json", "status", "--board", record.board]);

  if (status.code !== 0) throw failed(status, `finding board ${record.board}`);

  let boardId: string | null = null;

  try {
    const parsed = BoardStatus.safeParse(JSON.parse(status.stdout));

    boardId = parsed.success ? parsed.data.data.board.id : null;
  } catch {
    boardId = null;
  }

  if (boardId === null || !record.url.endsWith(`/v1/b/${boardId}`))
    throw new CliError(
      "CONFLICT",
      `the saved board ${record.board} is not the board at ${record.url} that issued token ${record.tokenId}`,
    );

  const ran = await capture(session, [
    "--json",
    "token",
    "revoke",
    record.tokenId,
    "--board",
    record.board,
  ]);

  if (ran.code === 0 || failureOf(ran)?.reason === "token_not_found") return;

  throw failed(ran, `revoking token ${record.tokenId} on board ${record.board}`);
}

/** The note a cleanup prints when a board token could not be revoked. */
export function revokeNote(name: string, board: SandboxBoardRecord, cause: unknown): string {
  return `${name}: could not revoke board token ${board.tokenId} (${cause instanceof Error ? cause.message : String(cause)}); ${board.expiresAt ? `it expires ${board.expiresAt}` : "it does not expire"}. Revoke it with \`beachside board token revoke ${board.tokenId} --board ${board.board}\``;
}

/**
 * Revoke the board token a removed sandbox carried. Removal already happened, so a failure is a
 * note: the token keeps working until it expires.
 */
export async function revokeRecordedBoardToken(
  session: Session,
  record: SandboxRecord,
): Promise<void> {
  const board = record.board;

  if (!board || (board.expiresAt !== null && Date.parse(board.expiresAt) <= Date.now())) return;

  try {
    await revokeBoardToken(session, board);
  } catch (cause) {
    session.ctx.out.note(revokeNote(record.name, board, cause));
  }
}

/** What `show` prints about the recorded token. Never the token itself. */
export function boardLines(record: SandboxRecord): string[] {
  const board = record.board;

  if (!board) return [];

  return [
    `board     ${board.board} as ${board.agent} (${board.role}), token ${board.tokenId}, ${board.expiresAt ? `expires ${board.expiresAt}` : "no expiry"}`,
    `          env ${boardEnv.join(" ")}`,
  ];
}

/** beachbar's arguments for `beachside board <args>`. */
export function beachbarArguments(args: readonly string[], json: boolean): string[] {
  // The command word is the first argument that is neither a flag nor a global flag's value.
  let index = 0;

  while (index < args.length && args[index]?.startsWith("-")) {
    index += valueFlags.has(args[index] ?? "") ? 2 : 1;
  }

  const first = args[index];

  const words =
    first !== undefined && boardActions.some((action) => action === first)
      ? [...args.slice(0, index), "board", ...args.slice(index)]
      : [...args];

  return json ? ["--json", ...words] : words;
}

/**
 * `beachside board ...`: runs `beachbar` with the same arguments, so the board's own commands,
 * help and `watch` work unchanged. Board management words (`create`, `ls`, `guard`, ...) are
 * `beachbar board <word>`; everything else is passed as it is.
 */
export async function boardCommand(session: Session, flags: Flags): Promise<number> {
  const args = flags.positionals.length
    ? beachbarArguments(flags.positionals, session.ctx.out.json)
    : ["help"];

  return await new Promise<number>((done, fail) => {
    const child = spawn(beachbarPath(session), args, {
      env: { ...session.ctx.env },
      stdio: "inherit",
    });

    child.on("error", (cause) =>
      fail("code" in cause && cause.code === "ENOENT" ? missing() : cause),
    );
    child.on("close", (code, signal) => done(code ?? (signal ? 130 : 1)));
  });
}
