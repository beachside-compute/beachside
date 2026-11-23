import { parseEnvFile } from "./env-file";
import { chmod, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createCredentialBroker,
  CredentialBrokerError,
  maxGrantTtlSeconds,
  type SandboxGrant,
} from "@beachside/credential-client";
import { runBrokerCli } from "@beachside/credential-client/cli";
import { z } from "zod";
import { BrokerConfig, BrokerName, resolveEnvReferences } from "./config";
import type { Flags } from "./commands";
import { CliError, redact, registerSecret, usage } from "./output";
import { renderRows, updateConfig } from "./profiles";
import type { Session } from "./session";
import type { SandboxGrantRecord, SandboxRecord } from "./store";
import { parseDuration } from "./units";

/** The command prefix broker hints name, so every fix is a command this CLI runs. */
const prefix = "beachside broker";

export const brokerActions = ["add", "ls", "use", "rm"] as const;

/** Groups handed to the broker's own command line with this broker's URL and keys. */
const managedGroups = ["status", "config", "integration", "issuer", "grant"] as const;

/** A broker as one command reaches it; keys are read only when a call needs them. */
export type ResolvedBroker = {
  /** The name in beachside.json; absent for BEACHSIDE_BROKER_URL. */
  name?: string;
  url: string;
  issuerKey: () => Promise<string | undefined>;
  adminKey: () => Promise<string | undefined>;
};

const setupHint = `add one with \`${prefix} add <name> --url https://broker.example.com --issuer-key env:BEACHSIDE_BROKER_ISSUER_KEY\`, or set BEACHSIDE_BROKER_URL and BEACHSIDE_BROKER_ISSUER_KEY`;

/** Read a key from beachside.json: a value, env:NAME or a password-manager reference. */
async function readKey(
  session: Session,
  value: string | undefined,
  where: string,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const resolved = z.string().parse(resolveEnvReferences(value, session.ctx.env, where));
  const key = await session.secret(resolved, where);

  // A broker key is a credential however it was given, so nothing the CLI prints may carry it.
  registerSecret(key);

  return key;
}

/**
 * The broker a command uses: --broker, then BEACHSIDE_BROKER, then `defaultBroker`, then the only
 * configured broker, then BEACHSIDE_BROKER_URL. A configured broker without a key falls back to
 * the environment's key.
 */
export async function resolveBroker(session: Session, chosen?: string): Promise<ResolvedBroker> {
  const { value, path } = await session.config();
  const { env } = session.ctx;
  const brokers = value.brokers ?? {};
  const names = Object.keys(brokers);

  const name =
    chosen ??
    (env.BEACHSIDE_BROKER || undefined) ??
    value.defaultBroker ??
    (names.length === 1 && !env.BEACHSIDE_BROKER_URL ? names[0] : undefined);

  if (name === undefined) {
    const url = env.BEACHSIDE_BROKER_URL;

    if (!url)
      throw new CliError(
        "USAGE",
        names.length
          ? `Several brokers are configured (${names.join(", ")}) and none is the default`
          : "No credential broker is set up",
        names.length ? `pick one with --broker <name> or \`${prefix} use <name>\`` : setupHint,
      );

    return {
      url,
      issuerKey: async () => env.BEACHSIDE_BROKER_ISSUER_KEY || undefined,
      adminKey: async () => env.BEACHSIDE_BROKER_ADMIN_KEY || undefined,
    };
  }

  const config = brokers[name];

  if (!config)
    throw new CliError(
      "NOT_FOUND",
      `Broker ${name} is not defined in ${path}`,
      names.length ? `configured brokers: ${names.join(", ")}` : setupHint,
    );

  return {
    name,
    url: config.url,
    issuerKey: async () =>
      (await readKey(session, config.issuerKey, `brokers.${name}.issuerKey`)) ??
      (env.BEACHSIDE_BROKER_ISSUER_KEY || undefined),
    adminKey: async () =>
      (await readKey(session, config.adminKey, `brokers.${name}.adminKey`)) ??
      (env.BEACHSIDE_BROKER_ADMIN_KEY || undefined),
  };
}

function brokerLabel(broker: ResolvedBroker): string {
  return broker.name ?? "BEACHSIDE_BROKER_URL";
}

async function issuerClient(session: Session, broker: ResolvedBroker) {
  const apiKey = await broker.issuerKey();

  if (!apiKey)
    throw new CliError(
      "USAGE",
      `Broker ${brokerLabel(broker)} has no issuer key`,
      broker.name
        ? `set brokers.${broker.name}.issuerKey in beachside.json (env:NAME or a password-manager reference works), or BEACHSIDE_BROKER_ISSUER_KEY`
        : "set BEACHSIDE_BROKER_ISSUER_KEY to BROKER_ISSUER_KEY from the deployment",
    );

  try {
    return createCredentialBroker({ url: broker.url, auth: { apiKey } });
  } catch (cause) {
    throw brokerError(cause, broker);
  }
}

const refusals = new Map([
  [
    "not_found",
    (ids: string) => [
      `No integration named ${ids} exists on this broker`,
      `\`${prefix} integration list\` lists them`,
    ],
  ],
  [
    "disabled",
    (ids: string) => [
      `Integration ${ids} is disabled`,
      `enable it with \`${prefix} integration enable ${ids}\``,
    ],
  ],
  [
    "not_allowlisted",
    (ids: string) => [
      `Integration ${ids} is not allowed to issue grants`,
      `allow it with \`${prefix} issuer allow ${ids.replaceAll(", ", " ")}\``,
    ],
  ],
  [
    "not_in_policy",
    (ids: string) => [
      `This workflow's broker policy does not include ${ids}`,
      "add it to the workflow's integrations in BROKER_CONFIG and redeploy",
    ],
  ],
]);

/** A broker client failure as a CLI error whose hints name `beachside broker` commands. */
export function brokerError(cause: unknown, broker: ResolvedBroker): Error {
  if (!(cause instanceof CredentialBrokerError))
    return cause instanceof Error ? cause : new Error(String(cause));
  const refusal = cause.reason && refusals.get(cause.reason);

  if (refusal) {
    const [message, hint] = refusal((cause.integrations ?? []).join(", "));

    return new CliError("FORBIDDEN", message!, hint);
  }

  const hint =
    cause.code === "UNAUTHENTICATED"
      ? `check the key for broker ${brokerLabel(broker)}; \`${prefix} status\` shows which key it accepts`
      : cause.code === "TIMEOUT" || cause.code === "WAIT_ABORTED"
        ? `the broker may have applied it; \`${prefix} grant list\` shows active grants`
        : undefined;

  return new CliError(
    cause.code,
    `Credential broker ${brokerLabel(broker)}: ${cause.message}`,
    hint,
    undefined,
    cause.code === "TIMEOUT" || cause.code === "WAIT_ABORTED" ? "unknown" : "rejected",
  );
}

/** What `--grant` asked for: integrations set up by kind, and ones with named variables. */
export type GrantRequest = {
  broker?: string;
  integrations: string[];
  endpoints: { integration: string; baseURLEnv: string; apiKeyEnv: string }[];
  ttlSeconds: number;
};

/** Grants made for a sandbox last an hour unless --grant-ttl says otherwise. */
const defaultGrantSeconds = 3_600;

/**
 * Parse `--grant <id>` (variables follow the integration's kind) and
 * `--grant <id>=BASE_URL_ENV,API_KEY_ENV` (variables you name).
 */
export function grantRequest(flags: Flags): GrantRequest | null {
  const specs = flags.strings("grant").flatMap((value) => value.split(/\s+/).filter(Boolean));
  const ttl = flags.string("grant-ttl");
  const broker = flags.string("broker");

  if (!specs.length) {
    if (ttl !== undefined) throw usage("--grant-ttl needs --grant");

    if (broker !== undefined) throw usage("--broker needs --grant");

    return null;
  }

  const request: GrantRequest = {
    broker,
    integrations: [],
    endpoints: [],
    ttlSeconds: ttl === undefined ? defaultGrantSeconds : parseDuration(ttl, "grant-ttl"),
  };

  if (request.ttlSeconds > maxGrantTtlSeconds)
    throw usage(
      "--grant-ttl can be at most 7d",
      `renew it later with \`${prefix} grant renew <sandbox>\``,
    );

  for (const spec of specs) {
    const match =
      /^([a-z][a-z0-9-]{0,31})(?:=([A-Z_][A-Z0-9_]{0,63}),([A-Z_][A-Z0-9_]{0,63}))?$/.exec(spec);

    if (!match)
      throw usage(
        `Invalid --grant ${spec}`,
        "pass an integration id, such as --grant openrouter, or id=BASE_URL_ENV,API_KEY_ENV to name its variables",
      );
    const [, id, baseURLEnv, apiKeyEnv] = match;

    if (
      request.integrations.includes(id!) ||
      request.endpoints.some((entry) => entry.integration === id)
    )
      throw usage(`--grant names ${id} twice`);

    if (baseURLEnv && apiKeyEnv)
      request.endpoints.push({ integration: id!, baseURLEnv, apiKeyEnv });
    else request.integrations.push(id!);
  }

  return request;
}

export type AcquiredGrant = { grant: SandboxGrant; record: SandboxGrantRecord };

/** Issue a grant for a sandbox and build its environment, before the sandbox exists. */
export async function acquireGrant(
  session: Session,
  request: GrantRequest,
  label: string,
): Promise<AcquiredGrant> {
  const broker = await resolveBroker(session, request.broker);
  const client = await issuerClient(session, broker);

  try {
    const grant = await client
      .sandbox({
        integrations: request.integrations,
        endpoints: request.endpoints,
        ttlSeconds: request.ttlSeconds,
        label,
      })
      .acquire(session.ctx.signal);

    return {
      grant,
      record: {
        ...(broker.name && { broker: broker.name }),
        url: new URL(broker.url).origin,
        id: grant.id,
        integrations: [...grant.integrations],
        env: Object.keys(grant.env).sort(),
        expiresAt: grant.expiresAt,
      },
    };
  } catch (cause) {
    throw brokerError(cause, broker);
  }
}

/** The broker that issued a recorded grant, if this machine can still reach it with a key. */
async function recordedBroker(
  session: Session,
  grant: SandboxGrantRecord,
): Promise<ResolvedBroker | null> {
  const broker = await resolveBroker(session, grant.broker).catch(() => null);

  if (!broker || new URL(broker.url).origin !== grant.url) return null;

  return broker;
}

/**
 * Revoke the grant a removed sandbox carried. Removal already happened, so a failure is a note:
 * the grant stays usable only until it expires.
 */
export async function revokeRecordedGrant(session: Session, record: SandboxRecord): Promise<void> {
  const grant = record.grant;

  if (!grant || Date.parse(grant.expiresAt) <= Date.now()) return;
  const broker = await recordedBroker(session, grant);

  const keep = (why: string) =>
    session.ctx.out.note(
      `${record.name}: could not revoke grant ${grant.id} (${why}); it expires ${grant.expiresAt}. Revoke it with \`${prefix} grant revoke ${grant.id}\``,
    );

  if (!broker) return keep(`broker ${grant.broker ?? grant.url} is not configured here`);

  try {
    await (
      await issuerClient(session, broker)
    ).revoke(grant.id, { signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    if (cause instanceof CredentialBrokerError && cause.code === "NOT_FOUND") return;
    keep(cause instanceof Error ? cause.message : String(cause));
  }
}

/** A credential-broker deployment file: dotenv lines, private to its owner like the broker requires. */
async function deploymentFile(session: Session, path: string): Promise<Record<string, string>> {
  const file = resolve(session.ctx.cwd, path);
  let text: string;

  try {
    if (((await stat(file)).mode & 0o077) !== 0)
      throw usage(`${file} is readable by other users`, `run chmod 600 ${file}`);
    text = await readFile(file, "utf8");
  } catch (cause) {
    if (cause instanceof CliError) throw cause;
    throw usage(`Cannot read --deployment ${file}`);
  }

  return parseEnvFile(text, file);
}

/** `beachside broker add <name> --url <origin> [--issuer-key <ref>] [--admin-key <ref>] [--default]`. */
async function addBroker(session: Session, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      "issuer-key": { type: "string" },
      "admin-key": { type: "string" },
      deployment: { type: "string" },
      default: { type: "boolean" },
      "no-check": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });

  // The broker's own `.env.deploy` holds its URL and both keys; explicit flags win over it.
  const deployment = values.deployment ? await deploymentFile(session, values.deployment) : {};
  values.url ??= deployment.BEACHSIDE_BROKER_URL;
  values["issuer-key"] ??= deployment.BROKER_ISSUER_KEY;
  values["admin-key"] ??= deployment.BROKER_ADMIN_KEY;

  if (positionals.length !== 1) throw usage("broker add takes one broker name");
  const name = positionals[0]!;

  if (!BrokerName.safeParse(name).success)
    throw usage(`Invalid broker name ${name}`, "use lowercase letters, digits and dashes");

  if (!values.url)
    throw usage(
      "broker add needs --url <origin>",
      values.deployment ? `${values.deployment} has no BEACHSIDE_BROKER_URL` : undefined,
    );

  if (!values["issuer-key"] && !values["admin-key"])
    throw usage(
      "broker add needs --issuer-key, --admin-key or both",
      "prefer a reference such as env:BEACHSIDE_BROKER_ISSUER_KEY or op://vault/broker/issuer, so the key stays out of the file",
    );

  if (values["issuer-key"] === "-" && values["admin-key"] === "-")
    throw usage("Only one key can be read from stdin");

  const stdin = async () => {
    const parts: Uint8Array[] = [];

    for await (const chunk of session.ctx.stdin()) parts.push(chunk);

    const text = Buffer.concat(parts)
      .toString("utf8")
      .replace(/\r?\n$/, "");

    if (!text) throw usage("A key given as - read nothing from stdin");

    return text;
  };

  const issuerKey = values["issuer-key"] === "-" ? await stdin() : values["issuer-key"];
  const adminKey = values["admin-key"] === "-" ? await stdin() : values["admin-key"];
  const config = BrokerConfig.parse({ url: values.url, issuerKey, adminKey });

  let origin: string;

  try {
    const url = new URL(config.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
    origin = url.origin;
  } catch {
    throw usage(
      `--url ${config.url} is not an HTTPS origin`,
      "use https://, or http:// only for localhost while running the broker locally",
    );
  }

  const loaded = await session.config();

  // Ask the broker which role each key has before saving, so a typo fails here and not mid-create.
  const checks: string[] = [];

  if (!values["no-check"]) {
    for (const [role, key] of [
      ["issuer", issuerKey],
      ["admin", adminKey],
    ] as const) {
      if (key === undefined) continue;
      const apiKey = await readKey(session, key, `--${role}-key`);

      const broker: ResolvedBroker = {
        name,
        url: origin,
        issuerKey: async () => apiKey,
        adminKey: async () => apiKey,
      };

      try {
        const status = await createCredentialBroker({
          url: origin,
          auth: { apiKey: apiKey! },
        }).status({
          signal: session.ctx.signal,
        });

        if (status.role !== role)
          throw new CliError(
            "USAGE",
            `The --${role}-key is the broker's ${status.role} key`,
            `pass it as --${status.role === "admin" ? "admin" : "issuer"}-key`,
          );
        checks.push(`${role} key ok`);
      } catch (cause) {
        throw brokerError(cause, broker);
      }
    }
  }

  const plain = [issuerKey, adminKey].some(
    (key) => key !== undefined && !/^(env:|op:\/\/|bws:\/\/|pass:\/\/|keychain:\/\/)/.test(key),
  );

  let makeDefault = values.default === true;

  await updateConfig(loaded.path, (raw) => {
    const brokers = z.record(z.string(), z.json()).parse(raw.brokers ?? {});
    makeDefault ||= raw.defaultBroker === undefined && !Object.keys(brokers).length;
    // Adding a key to a broker at the same URL keeps the key it already has.
    const existing = BrokerConfig.safeParse(brokers[name]);

    const kept: Partial<BrokerConfig> =
      existing.success && existing.data.url === origin ? existing.data : {};

    const saved = {
      url: origin,
      ...((issuerKey ?? kept.issuerKey) && { issuerKey: issuerKey ?? kept.issuerKey }),
      ...((adminKey ?? kept.adminKey) && { adminKey: adminKey ?? kept.adminKey }),
    };

    return {
      ...raw,
      brokers: { ...brokers, [name]: saved },
      ...(makeDefault && { defaultBroker: name }),
    };
  });

  // A key written as a value must be readable only by this user, as `init` does for provider keys.
  if (plain) await chmod(loaded.path, 0o600);

  session.ctx.out.success(
    {
      name,
      url: origin,
      default: makeDefault,
      issuerKey: Boolean(issuerKey),
      adminKey: Boolean(adminKey),
      config: loaded.path,
    },
    [
      `added broker ${name} (${origin})${makeDefault ? " as the default" : ""}${checks.length ? `: ${checks.join(", ")}` : ""}`,
      ...(plain ? [`note: ${loaded.path} now holds a key; it is readable only by you (0600)`] : []),
      `next: \`${prefix} status\`, or create a sandbox with \`beachside create --grant <integration>\``,
    ].join("\n"),
  );

  return 0;
}

async function listBrokers(session: Session): Promise<number> {
  const { value, path } = await session.config();
  const { env } = session.ctx;

  const rows = Object.entries(value.brokers ?? {}).map(([name, config]) => ({
    name,
    url: config.url,
    default: value.defaultBroker === name,
    issuerKey: Boolean(config.issuerKey),
    adminKey: Boolean(config.adminKey),
  }));

  const fromEnv = env.BEACHSIDE_BROKER_URL
    ? {
        url: env.BEACHSIDE_BROKER_URL,
        issuerKey: Boolean(env.BEACHSIDE_BROKER_ISSUER_KEY),
        adminKey: Boolean(env.BEACHSIDE_BROKER_ADMIN_KEY),
      }
    : null;

  const keys = (row: { issuerKey: boolean; adminKey: boolean }) =>
    [row.issuerKey && "issuer", row.adminKey && "admin"].filter(Boolean).join(", ") || "none";

  const table = [
    ["NAME", "URL", "KEYS", ""],
    ...rows.map((row) => [row.name, row.url, keys(row), row.default ? "default" : ""]),
    ...(fromEnv
      ? [["(env)", fromEnv.url, keys(fromEnv), rows.length ? "" : "used without a name"]]
      : []),
  ];

  session.ctx.out.success(
    { brokers: rows, env: fromEnv, config: path },
    table.length > 1 ? renderRows(table) : `no brokers in ${path}\n${setupHint}`,
  );

  return 0;
}

async function useBroker(session: Session, args: string[]): Promise<number> {
  if (args.length !== 1) throw usage("broker use takes one broker name");
  const name = args[0]!;
  const loaded = await session.config();

  if (!loaded.value.brokers?.[name])
    throw new CliError(
      "NOT_FOUND",
      `Broker ${name} is not defined in ${loaded.path}`,
      `\`${prefix} ls\` lists brokers`,
    );

  await updateConfig(loaded.path, (raw) =>
    raw.defaultBroker === name ? null : { ...raw, defaultBroker: name },
  );
  session.ctx.out.success({ default: name }, `default broker is now ${name}`);

  return 0;
}

async function removeBroker(session: Session, args: string[]): Promise<number> {
  if (args.length !== 1) throw usage("broker rm takes one broker name");
  const name = args[0]!;
  const loaded = await session.config();

  if (!loaded.value.brokers?.[name])
    throw new CliError(
      "NOT_FOUND",
      `Broker ${name} is not defined in ${loaded.path}`,
      `\`${prefix} ls\` lists brokers`,
    );

  await updateConfig(loaded.path, (raw) => {
    const { [name]: _removed, ...others } = z.record(z.string(), z.json()).parse(raw.brokers ?? {});
    const { defaultBroker, ...rest } = raw;

    return { ...(defaultBroker === name ? rest : raw), brokers: others };
  });

  session.ctx.out.success(
    { removed: name },
    `removed broker ${name}; its grants keep working until they expire or are revoked`,
  );

  return 0;
}

/** The stored sandbox `grant renew|revoke <target>` names, if the target is one rather than a grant id. */
async function sandboxTarget(session: Session, args: readonly string[]) {
  const [group, action, target] = args;

  if (group !== "grant" || (action !== "renew" && action !== "revoke") || !target) return null;

  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(target) || /^[0-9a-f]{8}-/.test(target)) return null;

  return (await session.store()).get("sandbox", target);
}

/**
 * `beachside broker grant renew|revoke <sandbox>`: act on the grant the sandbox's create recorded,
 * at the broker that issued it, and keep the record's expiry in step.
 */
async function sandboxGrantCommand(
  session: Session,
  action: "renew" | "revoke",
  entry: { record: SandboxRecord; version: string },
  rest: string[],
): Promise<number> {
  const { record } = entry;

  const { values, positionals } = parseArgs({
    args: rest,
    options: { ttl: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });

  if (positionals.length) throw usage(`grant ${action} takes one sandbox or grant id`);

  if (action === "revoke" && values.ttl !== undefined)
    throw usage("--ttl applies only to grant renew");
  const grant = record.grant;

  if (!grant)
    throw new CliError(
      "NOT_FOUND",
      `Sandbox ${record.name} has no grant`,
      "create one with `beachside create --grant <integration>`",
    );
  const broker = await recordedBroker(session, grant);

  if (!broker)
    throw new CliError(
      "NOT_FOUND",
      `Broker ${grant.broker ?? grant.url}, which issued ${record.name}'s grant, is not configured here`,
      setupHint,
    );
  const client = await issuerClient(session, broker);
  const store = await session.store();
  const { grant: _grant, ...withoutGrant } = record;

  try {
    if (action === "revoke") {
      await client.revoke(grant.id, { signal: session.ctx.signal });
      await store.update("sandbox", record.name, withoutGrant, entry.version);
      session.ctx.out.success(
        { sandbox: record.name, revoked: true, id: grant.id },
        `revoked ${record.name}'s grant; its broker calls now fail with 401`,
      );

      return 0;
    }

    const ttlSeconds =
      values.ttl === undefined ? defaultGrantSeconds : parseDuration(values.ttl, "ttl");

    if (ttlSeconds > maxGrantTtlSeconds) throw usage("--ttl can be at most 7d");
    const renewed = await client.renew(grant.id, ttlSeconds, { signal: session.ctx.signal });
    const updated = { ...grant, expiresAt: renewed.expiresAt };
    await store.update("sandbox", record.name, { ...record, grant: updated }, entry.version);
    session.ctx.out.success(
      { sandbox: record.name, grant: updated },
      `renewed ${record.name}'s grant; it now expires ${renewed.expiresAt}`,
    );

    return 0;
  } catch (cause) {
    throw brokerError(cause, broker);
  }
}

/** Hand a management command to the broker's own command line, with this broker's URL and key. */
async function managedCommand(session: Session, flags: Flags, args: string[]): Promise<number> {
  const { out } = session.ctx;

  // The broker's own help needs no broker.
  if (args.includes("--help") || args.includes("-h"))
    return runBrokerCli(args, {
      env: {},
      prefix,
      stdout: (text) => out.streams.stdout(redact(`${text}\n`)),
      stderr: (text) => out.streams.stderr(redact(`${text}\n`)),
    });

  // The configured keys only go to the configured broker's URL.
  if (args.some((arg) => arg === "--url" || arg.startsWith("--url=")))
    throw usage(
      `--url applies only to \`${prefix} add\``,
      "pick a configured broker with --broker <name>, or add one with `beachside broker add <name> --url <origin>`",
    );
  const entry = await sandboxTarget(session, args);

  if (entry)
    return sandboxGrantCommand(
      session,
      args[1] === "renew" ? "renew" : "revoke",
      entry,
      args.slice(3),
    );
  const broker = await resolveBroker(session, flags.string("broker"));

  // Grant commands use the issuer key, except `grant list --all`; everything else the admin key.
  const usesIssuer = args[0] === "grant" && !args.includes("--all");
  const [issuerKey, adminKey] = await Promise.all([broker.issuerKey(), broker.adminKey()]);

  const env = {
    BEACHSIDE_BROKER_URL: broker.url,
    ...(issuerKey && { BEACHSIDE_BROKER_ISSUER_KEY: issuerKey }),
    ...(adminKey &&
      (!usesIssuer || args[0] === "status") && { BEACHSIDE_BROKER_ADMIN_KEY: adminKey }),
  };

  let stdout = "";
  let stderr = "";

  const code = await runBrokerCli([...args, ...(out.json ? ["--json"] : [])], {
    env,
    prefix,
    stdout: (text) => {
      if (out.json) stdout += text;
      else out.streams.stdout(redact(`${text}\n`));
    },
    stderr: (text) => {
      if (out.json) stderr += text;
      else out.streams.stderr(redact(`beachside broker: ${text}\n`));
    },
  });

  if (!out.json) return code;

  if (code === 0) {
    out.success(JSON.parse(stdout || "null"), "");

    return 0;
  }

  const failure = z
    .object({ error: z.object({ code: z.string(), message: z.string() }).loose() })
    .safeParse(JSON.parse(stderr || "{}"));

  const error = failure.success ? failure.data.error : { code: "INTERNAL", message: stderr.trim() };

  out.streams.stdout(
    redact(
      `${JSON.stringify({
        ok: false,
        error: { ...error, retryable: code === 7, outcome: code === 6 ? "unknown" : "rejected" },
      })}\n`,
    ),
  );

  return code;
}

/** `beachside broker ...`: configure brokers here, and manage a broker's integrations and grants. */
export async function brokerCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...args] = flags.positionals;

  switch (action) {
    case "add":
      return addBroker(session, args);
    case "ls":
      if (args.length) throw usage("broker ls takes no arguments");

      return listBrokers(session);
    case "use":
      return useBroker(session, args);
    case "rm":
      return removeBroker(session, args);
    default:
      if (!action || !managedGroups.some((group) => group === action))
        throw usage(
          action ? `Unknown broker command ${action}` : "Expected a broker command",
          `use one of: ${[...brokerActions, ...managedGroups].join(", ")}; \`${prefix} --help\` lists them`,
        );

      return managedCommand(session, flags, [...flags.positionals]);
  }
}
