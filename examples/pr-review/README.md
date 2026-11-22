# Review pull requests with Pi

A GitHub Actions workflow that reviews each pull request when it becomes ready for review. Pi runs in a Freestyle sandbox, reads the change in a clone of the repository, and posts one review comment that covers every finding with `gh pr review --comment`.

The repository holds no GitHub or model keys. The job asks the [credential broker](https://beachside.run/docs/credential-broker/) for a grant with its own GitHub Actions OIDC token. The grant lets `git` and `gh` in the sandbox reach GitHub, and Pi reach the model gateway, through the broker. The only secret in the repository is the Freestyle API key, which stays on the runner.

- [`.github/workflows/pr-review.yml`](../../.github/workflows/pr-review.yml) runs [`review.ts`](review.ts) for each pull request.
- [`.github/workflows/pr-review-maintenance.yml`](../../.github/workflows/pr-review-maintenance.yml) runs [`image.ts`](image.ts) weekly and [`sweep.ts`](sweep.ts) hourly.

## When it runs

The review job runs on `pull_request_target` for `opened` and `ready_for_review`, only when all of these hold:

- the repository variable `PR_REVIEW_ENABLED` is `true`;
- the pull request is not a draft;
- the pull request comes from this repository, never a fork;
- its author is an `OWNER`, `MEMBER` or `COLLABORATOR` of the repository.

`pull_request_target` runs the workflow from the default branch, so a pull request cannot change the workflow or the scripts. The job checks out only the default branch. The pull request is cloned inside the sandbox, through the broker. A pull request is reviewed when it becomes ready for review; later pushes do not start another review. Marking it ready again after it went back to draft starts a new review, which cancels one still running for the same pull request.

## What the review does

1. Connects to Freestyle with the newest prepared image, or the plain `freestyle/ubuntu-sm` base when there is none.
2. Creates a sandbox with a 30-minute Freestyle lifetime and a 30-minute grant for the GitHub and model integrations.
3. Installs Git, GitHub CLI, Node and Pi if the image does not have them already.
4. Clones the repository, fetches the base branch and `refs/pull/<n>/head`, and checks out the head.
5. Writes Pi's `models.json` inside the sandbox from the grant's base URL. Pi reads the grant token from the environment.
6. Runs `pi --print` with the `read`, `bash`, `grep`, `find` and `ls` tools and asks for exactly one comment-only review.
7. Checks that a review ending with this run's marker was posted, and fails the job if not.
8. Destroys the sandbox, which also revokes the grant.

## Model gateway

The default is Kilo AI Gateway with `deepseek/deepseek-v4.1-flash-1017`. Set the repository variable `PR_REVIEW_GATEWAY` to `openrouter` to use OpenRouter instead, and `PR_REVIEW_MODEL` to pick another model ID. Both gateways are broker integrations: the grant sets `KILO_BASE_URL` and `KILO_API_KEY`, or `OPENROUTER_BASE_URL` and `OPENROUTER_API_KEY`, in every command. `REVIEW_GATEWAY_INTEGRATION` and `REVIEW_GITHUB_INTEGRATION` override the integration IDs, which default to `kilo` (or `openrouter`) and `github-review`.

## Leaks

Every resource expires on its own, so cleanup steps are a backup:

| Resource | Expiry | Active cleanup |
| --- | --- | --- |
| Sandbox | Freestyle deletes it 30 minutes after creation. | Destroyed when the review ends, even after a failure. The hourly sweep destroys any sandbox labelled `beachside.pr-review` that is older than an hour. |
| Grant | Broker expiry after 30 minutes. | Revoked when the sandbox is destroyed. |
| Image snapshot | Freestyle deletes it 14 days after capture. | Replaced weekly. |
| Image build sandbox | Freestyle deletes it 30 minutes after creation. | Destroyed after capture; also covered by the sweep. |

The review job has a 30-minute timeout. A runner that disappears mid-job leaves only resources that expire within 30 minutes.

## Set up

### 1. Broker integrations

Add a GitHub integration backed by a fine-grained personal access token for the repositories to review, with **Contents: read** and **Pull requests: write** only. That lets the agent clone and post reviews, but not push or merge. Reviews appear as the token's owner, so a dedicated bot account reads best.

```sh
beachside broker integration create github-review --provider github --secret-stdin --allow-issue < /secure/path/review-token
```

Add Kilo AI Gateway with `beachside broker integration setup`, choose Kilo AI Gateway, and keep the ID `kilo`. For OpenRouter, the existing `openrouter` integration works.

### 2. Trust this workflow

Add the workflow to `githubActions` in the broker's `BROKER_CONFIG` and deploy the broker again. Pick an audience unique to the deployment. For this repository:

```json
{
  "githubActions": {
    "audience": "https://broker.example.com/github-actions",
    "workflows": [
      {
        "repositoryId": "1388434225",
        "repositoryOwnerId": "353477479",
        "repository": "beachside-compute/beachside",
        "ref": "refs/heads/main",
        "workflowRef": "beachside-compute/beachside/.github/workflows/pr-review.yml@refs/heads/main",
        "event": "pull_request_target",
        "integrations": ["github-review", "kilo", "openrouter"]
      }
    ]
  }
}
```

Run `beachside broker issuer allow github-review kilo openrouter` if the issuer may not grant them yet, and `beachside broker config show` to check what the deployed broker trusts. See [GitHub Actions](https://beachside.run/docs/credential-broker/github/#github-actions).

### 3. Repository settings

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `FREESTYLE_API_KEY` | A Freestyle API key. |
| Variable | `BEACHSIDE_BROKER_URL` | The broker's HTTPS origin. |
| Variable | `BEACHSIDE_BROKER_AUDIENCE` | The `audience` from the policy above. |
| Variable | `PR_REVIEW_ENABLED` | `true` to turn reviews, images and sweeps on. |
| Variable | `PR_REVIEW_GATEWAY` | Optional: `kilo` (default) or `openrouter`. |
| Variable | `PR_REVIEW_MODEL` | Optional: a model ID; defaults to `deepseek/deepseek-v4.1-flash-1017`. |

Then run **PR review maintenance** once by hand to build the first image. Reviews still work before it exists; they install the tools at the start, which takes longer.

## Images

`image.ts` boots `freestyle/ubuntu-sm`, installs Git and GitHub CLI from apt (GitHub's signed repository for `gh`), Node 24 from its checksummed release tarball, and Pi from npm at a pinned version, then captures a Freestyle snapshot with a 14-day retention. The snapshot ID goes into the Actions cache as `pr-review-image-<run>`, and review jobs restore the newest one. When the cached snapshot has expired, the review falls back to the base image and installs the tools itself. A version change in [`shared.ts`](shared.ts) makes older images reinstall until the next build. On November 21, 2026, a live build took 49 seconds, and a sandbox created from the snapshot was ready with no reinstall in under a second.

## Run it locally

Outside Actions, set `BEACHSIDE_BROKER_ISSUER_KEY` instead of the audience, plus `GITHUB_REPOSITORY`, `PR_NUMBER`, `PR_BASE_REF` and `FREESTYLE_API_KEY`, and run `bun run --cwd examples pr-review`. The review is posted for real.

## Test

```sh
bun test examples/pr-review
```

The tests drive the review against a scripted sandbox: the install check, the clone, Pi's command line and environment, and the posted-review check. They also run the guest `models.json` writer under Node and check the sweep's selection. They make no provider, broker or model calls.
