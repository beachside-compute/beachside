# Beachside documentation site

This workspace builds the development documentation at the canonical origin `https://beachside.run`. It is static Astro 7 with Starlight 0.42 and Pagefind. The landing page is `/`; curated docs are under `/docs/`.

## Work locally

From the repository root, install Bun 1.4.4 and run:

```sh
bun install --frozen-lockfile
bun run docs:check
bun run --cwd apps/docs dev
```

`docs:check` builds public workspace packages, checks Astro content and TypeScript examples, validates Markdown routes and anchors, checks generated TypeScript and provider evidence, builds the static site and Pagefind index, checks output, and runs SDK quickstart flows against temporary fake provider processes. The fake is a simulation only.

The credential broker example and generated API index use the external client revision pinned in this workspace. The docs check builds that client with Beachside's TypeScript compiler. To update the pin, change the commit in `package.json`, refresh the root lockfile, and regenerate the TypeScript API index.

## Cloudflare Worker and static assets

`wrangler.jsonc` points at `./dist` and configures `404-page` fallback. A small Worker (`worker/index.ts`) sits in front of the assets: it answers `/beta` and `/beta/` with a 301 to `https://beachsidecompute.com/beta/`, keeping the query string so ad UTM tags survive, and hands every other request to the `ASSETS` binding. The 1.0 beta page and its signup endpoint live in the `beachside-landing` repository. Assets are served before the Worker runs, so no page may be built at `/beta/`. Tests: `bun test apps/docs/worker`.

To inspect routing locally after a build, use a Wrangler 4 installation and run `wrangler dev --config apps/docs/wrangler.jsonc` from the repository root (or run it in `apps/docs` with `--config wrangler.jsonc`). Unknown paths should return HTTP 404 with the generated `404.html`.

The Worker keeps its original name, `sandbar-docs`. It serves `beachside.run`, `beachside.sh`, `sandbarsdk.dev` and their `www.` hosts; all are bound as custom domains in `wrangler.jsonc`, so a deploy keeps them attached. Pages canonicalize to `https://beachside.run/`.

`.github/workflows/docs-deploy.yml` deploys on pushes to `main` that change `apps/docs/**`, `bun.lock` or the workflow itself, and can be run manually. It reruns `bun run docs:check` before `wrangler deploy`. It reads `CLOUDFLARE_API_TOKEN` (Workers Scripts edit and Workers Custom Domains/Zone edit for `beachside.run`) and `CLOUDFLARE_ACCOUNT_ID` from the protected `production` GitHub environment. Pull request checks only build and test; they receive no deployment credentials. Preview deployments, if introduced, should use `noindex` and must not publish an unmerged stack to the canonical domain. The canonical site is public: `robots.txt` allows all crawlers and lists the sitemap, and the dist check rejects `noindex` on any page.

## Content structure

Brand images are served from `public/brand/` at `https://beachside.run/brand/`.
`beachside/mark.png` is the transparent product sunset for email and other small
placements; `mark.svg` is its vector source, extracted from the product social
preview to match `src/components/Logo.astro`. The product social preview and the
`beachside-compute/` company logos are copied from the repository's `brand/`
directory. Keep these public URLs stable: sent emails may reference them long
after a deployment. Use PNG for email and SVG for vector uses.

The public docs focus on the SDK: getting started, agent prompts, everyday guides,
provider setup and tested support, adapter authoring, and TypeScript reference.
The landing page is maintained separately in `src/pages/index.astro`.

The getting started page imports `examples/getting-started-{daytona,e2b,modal}.ts`
as its displayed code, so all three copyable examples are checked by the examples
TypeScript project. Synchronized provider tabs switch install commands, credentials, code, and run commands together. The examples are not executed in offline checks because they
create real sandboxes. Getting started installs from npm; the Modal tab runs from a checkout because Modal is unpublished.

The Recipes section at `/docs/recipes/` has one page per application in the root
`examples/` directory (PR review, Pi tracing, OpenCode), each linking to its source.
When an example's README changes, keep its recipe page in step.
These applications are distinct from the docs fixtures in `apps/docs/examples/`;
their recorded live acceptance does not run during the docs build.

Provider test evidence comes from the reviewed JSON files in
`packages/sdk-qualification/provider-qualification/results/`. After an authorized
run, update the provider's existing file and run the qualification renderer.
Keep `providers/support.md` consistent with those operation-level results. The
normal docs build checks drift and never calls live providers.
