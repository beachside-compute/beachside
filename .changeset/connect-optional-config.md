---
"beachside": patch
"@beachside/adapter": patch
---

`Beachside.connect` no longer needs `config: {}` when every field of the adapter's config is optional (E2B, Freestyle and others); a left-out `config` is validated as `{}`. Adapters with a required config field still require `config` at compile time, and a missing field is named in the error (`Invalid configuration: target`) instead of a bare `Invalid configuration`.
