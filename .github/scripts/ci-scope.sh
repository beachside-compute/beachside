#!/usr/bin/env bash
set -euo pipefail

# Restrict the fast path to PRs. Main and manual runs retain full coverage.
full=true
docs=true
if [ "$EVENT" = pull_request ] && git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  full=false
  docs=false
  # Compare the entire PR, including both sides of renames. NUL delimiters preserve filenames.
  changed=$(mktemp)
  trap 'rm -f "$changed"' EXIT
  git diff --no-renames --name-only -z "$BASE...HEAD" > "$changed"
  while IFS= read -r -d '' path; do
    case "$path" in
      .github/ISSUE_TEMPLATE/*) ;;
      apps/docs/src/*|apps/docs/public/*|apps/docs/test/*|*.md|*.mdx)
        docs=true ;;
      *) full=true; docs=true ;;
    esac
  done < "$changed"
fi
printf 'full=%s\ndocs=%s\n' "$full" "$docs" >> "$GITHUB_OUTPUT"
