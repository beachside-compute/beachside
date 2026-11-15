---
"@beachside/cli": minor
---

`create --with herdr` now targets herdr-core, the server behind the Herdr app. Its connect line (`data.addons[].connect`) is `hc machine add <user>@<address> --temp --install --name <sandbox>`, which adds the sandbox to the Herdr sidebar as a short-lived machine, instead of the Herdr TUI command `herdr --remote ssh://<user>@<address>`, which still works with the same address. `rm` notes the `hc machine rm <sandbox>` that forgets it. The add-on also reads the device's Tailscale SSH host keys inside the sandbox: `create` and `inspect` print the ED25519 fingerprint to check at ssh's first-connect prompt, and JSON lists the keys as `known_hosts` lines in `knownHosts`.

Program status (OSC 7501) is now on by default inside herdr-core terminals as well as Rex. Outside Rex it reports the root record, which herdr-core shows, instead of a record with `id=beachside`, which it ignores.
