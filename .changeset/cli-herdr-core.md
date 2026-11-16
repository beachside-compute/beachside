---
"@beachside/cli": minor
---

`create --with herdr` now targets herdr-core, the server behind the Herdr app. Its connect line (`data.addons[].connect`) is `hc machine add <user>@<address> --temp --install --name <sandbox>` (without `--name` when herdr-core would refuse the sandbox's name), which adds the sandbox to the Herdr sidebar as a short-lived machine, instead of the Herdr TUI command `herdr --remote ssh://<user>@<address>`, which still works with the same address. `rm` and `gc` print the `hc machine rm <name>` that forgets it, finding the name with `hc machine ls` by the machine's address, and the `ssh-keygen -R <address>` that drops the host key ssh saved. The add-on also makes any host key the sandbox's `/etc/ssh` lacks with `ssh-keygen` before Tailscale starts, then reads the keys Tailscale SSH serves: `create` prints the ED25519 fingerprint to check at ssh's first-connect prompt, and JSON lists the keys as `known_hosts` lines in `knownHosts`. Host keys can change after `create`, so `inspect` reads a running sandbox's keys again, saves any that changed and says so with the old and new fingerprints.

Program status (OSC 7501) is now on by default inside herdr-core terminals as well as Rex. Outside Rex it reports the root record, the only one the Herdr app shows, instead of a record with `id=beachside`.
