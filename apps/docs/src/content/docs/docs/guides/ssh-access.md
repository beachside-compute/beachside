---
title: SSH access
description: Open a sandbox with a standard SSH client through the provider's own SSH service.
---

Some providers run an SSH service in front of their sandboxes. `box.sshTarget()` returns what a standard SSH client needs to reach a running sandbox through it: host, port, username, how to authenticate, and, where the provider publishes them, host keys. Port forwarding (`ssh -L`) then works as it does with any OpenSSH server.

Check `(await client.capabilities()).ssh` first. It reads the adapter's declaration only: it never contacts the provider, mints a credential or authorizes a key.

```ts
const caps = await client.capabilities();
if (caps.ssh.status === "supported") {
  const target = await box.sshTarget({ publicKey: myPublicKeyLine });
  // target.host, target.port, target.username, target.auth, target.hostKeys?, target.proxy?, target.expiresAt?
}
```

`caps.ssh.value` describes every target the adapter returns:

| Field       | Meaning                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`      | `publicKey`: present your own key. `privateKey`: use the returned `auth.privateKey`. `password`: answer the prompt with `auth.password`. `none`: the credential is the username itself. |
| `publicKey` | `required` or `optional`: `sshTarget({ publicKey })` authorizes your OpenSSH public key first. `unused`: the target carries its own credential and the option is ignored.               |
| `scope`     | `sandbox`: the credential or authorized key reaches this sandbox only. `account`: it reaches everything the provider account can.                                                       |
| `hostKeys`  | Targets carry the server's host keys (`ssh-ed25519 AAAA...` lines) for `known_hosts`. Otherwise the provider publishes none; decide how your client trusts the host.                    |
| `expires`   | Targets carry `expiresAt`. Ask for a new target after it passes.                                                                                                                        |
| `proxy`     | `tls`: connect through a TLS wrapper, for example `ProxyCommand openssl s_client -quiet -servername <serverName> -connect <host>:<port>`.                                               |

Adapters without SSH, and third-party adapters written before this API, report `{ status: "unsupported" }`, and `sshTarget()` rejects with `UNSUPPORTED`. A suspended sandbox is refused rather than woken; resume it first.

## Credentials

A target can hold a credential: a token, a password or a private key. Keep it in memory, hand it only to the SSH client, and never log or store it. Beachside never puts it in sandbox references, capability reports, errors or traces.

## Providers

| Provider    | Auth                                              | Scope   | Host keys | Expiry                              | Notes                                                                                                                        |
| ----------- | ------------------------------------------------- | ------- | --------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| boxd        | Your key, linked to the boxd account (`optional`) | account | yes       | none                                | Passing `publicKey` links it to your boxd account, so it reaches every machine you can. User `boxd`; per-machine proxy port. |
| Daytona     | Token as username (`none`)                        | sandbox | no        | `ssh.expiresInMinutes` (default 60) | Each call mints a new token on `ssh.app.daytona.io`.                                                                         |
| Upstash Box | Box API key as password                           | account | no        | none                                | The password is the account API key; console-registered SSH keys also work.                                                  |
| Boat        | Your key, authorized on the sandbox (`required`)  | sandbox | when sent | none                                | User `user` unless Boat names another.                                                                                       |
| Runloop     | Minted private key                                | sandbox | no        | none                                | Through the TLS gateway `ssh.runloop.ai:443`. Each call installs a new key on the devbox.                                    |

Freestyle and exe.dev document SSH gateways, but their adapters do not return targets yet. E2B, Vercel, Modal and Archil have no managed SSH endpoint: run your own SSH server and expose it, or use the CLI's Tailscale SSH add-on (`beachside create --with herdr`), which is a separate connection path.
