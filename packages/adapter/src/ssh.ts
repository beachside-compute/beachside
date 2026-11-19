import { z } from "zod";

/**
 * How a standard SSH client authenticates to a target.
 *
 * - `publicKey`: the client presents its own key, one the provider already trusts (a key linked to
 *   the account, or the `publicKey` passed to `sshTarget()`).
 * - `privateKey`: use the returned private key, which the provider supplies (it may be one the
 *   sandbox keeps for its whole life, not one made for this call).
 * - `password`: answer the password prompt with the returned value.
 * - `none`: the credential travels in `username`; no further prompt is expected.
 */
export type SshAuthMethod = "publicKey" | "privateKey" | "password" | "none";

/** What an adapter's SSH targets look like, reported without contacting the provider. */
export type SshCapabilities = {
  auth: SshAuthMethod;
  /**
   * Whether `sshTarget({ publicKey })` authorizes the caller's OpenSSH public key: `required`
   * targets need one, `optional` targets also accept keys the provider already trusts, and
   * `unused` targets carry their own credential and ignore it.
   */
  publicKey: "required" | "optional" | "unused";
  /** What the returned credential or an authorized key can reach. */
  scope: "sandbox" | "account";
  /** Targets carry the server's host keys, so clients can verify the host without prompting. */
  hostKeys: boolean;
  /** Targets carry `expiresAt`; request a new one when it passes. */
  expires: boolean;
  /** `tls`: clients reach the server through a TLS wrapper (`proxy`), such as an OpenSSH `ProxyCommand`. */
  proxy: "none" | "tls";
};

/** A TLS connection the SSH stream runs inside, sent to `host:port` with SNI `serverName`. */
export type SshProxy = { kind: "tls"; host: string; port: number; serverName: string };

export type SshAuth =
  | { method: "publicKey" }
  | { method: "privateKey"; privateKey: string }
  | { method: "password"; password: string }
  | { method: "none" };

/**
 * A destination a standard SSH client can open. It may hold credentials: keep it in memory, and
 * never log or persist it.
 */
export type SshTarget = {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  /** OpenSSH public-key lines (`ssh-ed25519 AAAA...`) the server presents. */
  hostKeys?: string[];
  proxy?: SshProxy;
  /** When the credential stops working. */
  expiresAt?: string;
};

const KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
] as const;

const KEY_LINE = new RegExp(
  `^(${KEY_TYPES.map((type) => type.replaceAll(".", "\\.")).join("|")}) [A-Za-z0-9+/]+={0,2}$`,
);

/** An OpenSSH public key line, type and base64 body; a trailing comment is dropped. */
export const SshPublicKey = z
  .string()
  .max(16384)
  .refine((value) => !/[\r\n\0]/.test(value.trim()), "Expected one line")
  .transform((value) => value.trim().split(/\s+/).slice(0, 2).join(" "))
  .pipe(z.string().regex(KEY_LINE, "Expected an OpenSSH public key such as ssh-ed25519 AAAA..."));

const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const Port = z.number().int().min(1).max(65535);

const Secret = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[^\r\n\0]+$/);

export const SshCapabilitiesSchema = z.strictObject({
  auth: z.enum(["publicKey", "privateKey", "password", "none"]),
  publicKey: z.enum(["required", "optional", "unused"]),
  scope: z.enum(["sandbox", "account"]),
  hostKeys: z.boolean(),
  expires: z.boolean(),
  proxy: z.enum(["none", "tls"]),
});

export const SshTargetResult = z.strictObject({
  host: Host,
  port: Port,
  username: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\s@\0]+$/),
  auth: z.discriminatedUnion("method", [
    z.strictObject({ method: z.literal("publicKey") }),
    z.strictObject({
      method: z.literal("privateKey"),
      privateKey: z
        .string()
        .min(1)
        .max(16384)
        .regex(/-----BEGIN [A-Z ]*PRIVATE KEY-----/),
    }),
    z.strictObject({ method: z.literal("password"), password: Secret }),
    z.strictObject({ method: z.literal("none") }),
  ]),
  hostKeys: z.array(z.string().regex(KEY_LINE)).min(1).max(16).optional(),
  proxy: z
    .strictObject({ kind: z.literal("tls"), host: Host, port: Port, serverName: Host })
    .optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
