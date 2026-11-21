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
const boardActions = ["create", "ls", "show", "archive", "rm", "set", "guard"] as const;

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
  const role = flags.string("board-role") ?? "worker";

  if (!boardRoles.some((entry) => entry === role))
    throw usage(
      `--board-role ${role} is not a sandbox role`,
      `use one of ${boardRoles.join(", ")}; the owner token never goes into a sandbox`,
    );
  const agent = flags.string("board-agent");

  if (agent !== undefined && !/^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent))
    throw usage("--board-agent takes 1-48 lowercase letters, digits, '.', '_' or '-'");
  const ttl = flags.string("board-ttl");

  // A token outlives its sandbox only by accident, so it follows the sandbox's own lifetime.
  const ttlSeconds =
    ttl === undefined
      ? Math.max(60, lifetimeSeconds ?? defaultTtlSeconds)
      : parseDuration(ttl, "board-ttl");

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

/** beachbar's error, as a Beachside error with its first hint. */
function failed(ran: Ran, what: string): CliError {
  const parsed = Failure.safeParse(JSON.parse(ran.stdout.trim() || "null"));

  if (!parsed.success)
    return new CliError(
      "BEACHBAR_FAILED",
      `${what} failed: ${ran.stderr.trim() || `exit ${ran.code}`}`,
    );
  const { error } = parsed.data;

  const code =
    error.code === "UNAUTHORIZED"
      ? "UNAUTHENTICATED"
      : error.code === "NOT_FOUND"
        ? "NOT_FOUND"
        : error.code === "FORBIDDEN"
          ? "FORBIDDEN"
          : "BEACHBAR_FAILED";

  return new CliError(code, `${what}: ${error.message}`, error.next[0]);
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

  if (ran.code !== 0) throw failed(ran, `minting a token on board ${request.board}`);
  const minted = Minted.parse(JSON.parse(ran.stdout));
  const { token, url, id, expiresAt, role } = minted.data;

  // The token is a credential: nothing the CLI prints may carry it.
  registerSecret(token);

  return {
    env: { BEACHBAR_URL: url, BEACHBAR_TOKEN: token },
    record: {
      board: request.board,
      url,
      tokenId: id,
      agent: minted.data.agent,
      role,
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    },
  };
}

/** Revoke a token by id on a board; a token the board no longer knows counts as revoked. */
export async function revokeBoardToken(
  session: Session,
  board: string,
  tokenId: string,
): Promise<void> {
  const ran = await capture(session, ["--json", "token", "revoke", tokenId, "--board", board]);

  if (ran.code === 0 || ran.code === 3) return;
  throw failed(ran, `revoking token ${tokenId} on board ${board}`);
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
    await revokeBoardToken(session, board.board, board.tokenId);
  } catch (cause) {
    session.ctx.out.note(
      `${record.name}: could not revoke board token ${board.tokenId} (${cause instanceof Error ? cause.message : String(cause)}); ${board.expiresAt ? `it expires ${board.expiresAt}` : "it does not expire"}. Revoke it with \`beachside board token revoke ${board.tokenId} --board ${board.board}\``,
    );
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
  const [first, ...rest] = args;

  const words =
    first !== undefined && boardActions.some((action) => action === first)
      ? ["board", first, ...rest]
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
