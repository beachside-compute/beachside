---
"@beachside/archil": patch
---

Archil is now a supported provider, out of experimental in the docs and on the landing page, after passing Beachside's live qualification on the Free plan. `makeDirectory` on an existing file now rejects with INVALID_ARGUMENT and no effect, recursive or not, instead of an unknown outcome. `renew()` and `resume()` now report the new session deadline, which Archil itself does not return.
