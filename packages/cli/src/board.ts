import { z } from "zod";
import type { Flags } from "./commands";
import { CliError, registerSecret, usage } from "./output";
import type { Session } from "./session";
import type { SandboxBoardRecord, SandboxRecord } from "./store";
import { parseDuration } from "./units";

/**
 * `beachside board ...` and `create --board` use beachbar's library, which reads the owner's
 * beachbar config, so boards and owner tokens stay in one place: `~/.config/beachbar/config.json`.
 */

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

type Beachbar = typeof import("@beachside/beachbar");

type BoardFailure = InstanceType<Beachbar["BoardError"]>;

/** beachbar's library, loaded only by the commands that use a board. */
async function beachbar(): Promise<Beachbar> {
  try {
    return await import("@beachside/beachbar");
  } catch (cause) {
    throw new CliError(
      "BEACHBAR_NOT_INSTALLED",
      `Cannot load beachbar, which \`beachside board\` and \`create --board\` use: ${cause instanceof Error ? cause.message : String(cause)}`,
      "reinstall the Beachside CLI; @beachside/beachbar ships with it",
    );
  }
}

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

/** A beachbar error, as a Beachside error with its first hint. */
function failed(lib: Beachbar, cause: unknown, what: string): CliError {
  if (!(cause instanceof lib.BoardError))
    return new CliError(
      "BEACHBAR_FAILED",
      `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );

  const code = codes.get(cause.code) ?? "BEACHBAR_FAILED";

  return new CliError(
    code,
    `${what}: ${cause.message}`,
    cause.next[0],
    undefined,
    "rejected",
    undefined,
    code === "RATE_LIMIT" || code === "UNAVAILABLE",
  );
}

/**
 * True when the board answered with an error, so the write did not happen. beachbar reports
 * anything without a clear answer (unreachable, a garbled reply, a dropped socket) as UNAVAILABLE.
 */
function rejected(lib: Beachbar, cause: unknown): cause is BoardFailure {
  return cause instanceof lib.BoardError && cause.code !== "UNAVAILABLE";
}

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

  const lib = await beachbar();
  const what = `minting a token on board ${request.board}`;

  let opened: ReturnType<Beachbar["openSavedBoard"]>;

  try {
    opened = lib.openSavedBoard(session.ctx.env, request.board);
  } catch (cause) {
    throw failed(lib, cause, what);
  }

  let minted: Awaited<ReturnType<typeof opened.client.mint>>;

  try {
    minted = await opened.client.mint(agent, request.role, request.ttlSeconds);
  } catch (cause) {
    if (rejected(lib, cause)) throw failed(lib, cause, what);

    throw new CliError(
      "BEACHBAR_FAILED",
      `beachbar may have minted a token on board ${request.board}, but no answer came back`,
      `the token may be live: list it with \`beachside board token ls --board ${request.board}\` and revoke it with \`beachside board token revoke <id> --board ${request.board}\``,
      undefined,
      "unknown",
    );
  }

  // The token is a credential: nothing the CLI prints may carry it.
  registerSecret(minted.token);

  const url = opened.saved.url;

  return {
    env: { BEACHBAR_URL: url, BEACHBAR_TOKEN: minted.token },
    record: {
      board: request.board,
      url,
      tokenId: minted.id,
      agent: minted.agent,
      role: minted.role,
      expiresAt: minted.expiresAt === null ? null : new Date(minted.expiresAt).toISOString(),
    },
  };
}

/**
 * Revoke a token by id on the board that issued it. The saved board must still be that board (a
 * re-created board under the same name has another URL); a token the board no longer knows counts
 * as revoked. Anything else is an error, never a silent success.
 */
export async function revokeBoardToken(
  session: Session,
  record: SandboxBoardRecord,
): Promise<void> {
  const lib = await beachbar();
  let opened: ReturnType<Beachbar["openSavedBoard"]>;

  try {
    opened = lib.openSavedBoard(session.ctx.env, record.board);
  } catch (cause) {
    throw failed(lib, cause, `finding board ${record.board}`);
  }

  if (opened.saved.url.replace(/\/+$/, "") !== record.url.replace(/\/+$/, ""))
    throw new CliError(
      "CONFLICT",
      `the saved board ${record.board} is not the board at ${record.url} that issued token ${record.tokenId}`,
    );

  try {
    await opened.client.revoke(record.tokenId);
  } catch (cause) {
    if (cause instanceof lib.BoardError && cause.reason === "token_not_found") return;

    throw failed(lib, cause, `revoking token ${record.tokenId} on board ${record.board}`);
  }
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
 * `beachside board ...`: runs beachbar's own CLI in this process with the same arguments, so the
 * board's commands, help and `watch` work unchanged. Board management words (`create`, `ls`,
 * `guard`, ...) are `beachbar board <word>`; everything else is passed as it is.
 */
export async function boardCommand(session: Session, flags: Flags): Promise<number> {
  const args = flags.positionals.length
    ? beachbarArguments(flags.positionals, session.ctx.out.json)
    : ["help"];

  const lib = await beachbar();

  return await lib.run(args, session.ctx.env, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    stdin: async () => {
      const parts: Uint8Array[] = [];

      for await (const chunk of session.ctx.stdin()) parts.push(chunk);

      return Buffer.concat(parts).toString("utf8");
    },
  });
}
