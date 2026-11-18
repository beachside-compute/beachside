---
"@beachside/adapter": minor
"@beachside/e2b": minor
"@beachside/freestyle": minor
"@beachside/archil": minor
---

**Breaking:** E2B, Freestyle and Archil scopes no longer fingerprint the API key. Each provider authorizes every call with the current key, so scope is now the service plus its endpoint (and region for Archil), and saved references keep working after a key rotation. E2B also drops the default template from its scope and sandbox markers. References and E2B sandboxes saved by earlier versions do not reopen; recreate them.

`adapterSuite` fixtures can now omit `alternate` when a provider has one fixed endpoint, and can pass `rotatedCredentials` to check that another key for the same account keeps the scope.
