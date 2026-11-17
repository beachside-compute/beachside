# Continuous integration

The [CI workflow](.github/workflows/ci.yml) builds the shared graph once per commit and runs independent validation jobs against those fresh outputs.

| Job       | Coverage                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `build`   | Locked install, lint/format, sequential package builds and workspace typechecks.                      |
| `offline` | SDK, adapter, provider and qualification fixtures.                                                    |
| `packed`  | Isolated Node/Bun consumers and observability fixtures when packaging inputs change.                  |
| `release` | Stable/prerelease release rehearsal (`release:fixture`) when the release tooling changes.             |
| `docs`    | Content/type checks, generated TypeScript and provider evidence, static site and executable examples. |
| `verify`  | Requires selected validation jobs to succeed; accepts only intentional `packed` and `release` skips.  |

Packed validation runs when manifests (including export maps), dependency locks, TypeScript/build configuration, package ignore files, public build entrypoints, package assets, qualification code or the packed recovery example change. Changes to CI workflows, release scripts or Changesets configuration also select it. Routine implementation edits, tests outside the qualification harness, documentation and changeset prose do not select it. Manual CI dispatches and unavailable base commits select packed validation conservatively. Renames check both the old and new paths.

The `release` job runs the stable/prerelease rehearsal when release scripts, `scripts/release-packages.json`, Changesets configuration, the CI, release or version workflows, or the root `package.json` change. It tests the release tooling rather than the packages being released, so the release workflow no longer repeats it. Manual dispatches and unavailable base commits select it conservatively. The npm/pnpm/Bun installer checks of the exact release tarballs stay in the release workflow.

The release workflow reuses a CI run only when that run passed on the same tree as the release commit with `quality`, `build`, `offline`, `packed` and `docs` all succeeding; a run that skipped `packed` does not count. Otherwise it runs the full qualification itself, including for code changes whose PR skipped packed validation. Ordinary PR builds, typechecks, offline tests and docs checks still run on every PR.

The build job archives fresh package `dist` directories. Consumer jobs restore the artifact from the same workflow run and commit after their locked install. There is no cross-run build cache. One-day artifact retention can require rebuilding an older run. Shared builds remain sequential.

`check`, `test`, `build`, `package:smoke` and `docs:check` rebuild their prerequisites. The `:built` variants require matching fresh outputs; they do not infer freshness from existing `dist` directories.

The [release workflow](.github/workflows/release-npm.yml) always builds, runs the packed consumers, packs the exact tarballs and checks them with npm, pnpm and Bun. It also runs lint, typechecks, SDK tests, tracing checks and documentation checks unless a complete CI run passed on the same tree. Publication requires an exact version tag reachable from main, qualified artifacts, a non-dry-run dispatch and the protected `npm` environment. Ordinary CI does not publish packages or call live providers.
