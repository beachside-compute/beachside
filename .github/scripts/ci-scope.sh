#!/usr/bin/env bash
set -euo pipefail

# Restrict the fast path to PRs. Main and manual runs retain full coverage.
full=true
docs=true
# Test roots for the offline job; "all" runs every offline test.
tests=all
if [ "$EVENT" = pull_request ] && git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  full=false
  docs=false
  roots=""
  shared=false
  # Compare the entire PR, including both sides of renames. NUL delimiters preserve filenames.
  changed=$(mktemp)
  trap 'rm -f "$changed"' EXIT
  git diff --no-renames --name-only -z "$BASE...HEAD" > "$changed"
  while IFS= read -r -d '' path; do
    case "$path" in
      .github/ISSUE_TEMPLATE/*) ;;
      apps/docs/src/*|apps/docs/public/*|apps/docs/test/*|*.md|*.mdx)
        docs=true ;;
      # Packaging files there select packed validation, which needs the full suite.
      */package.json|*/tsconfig*.json|*/.gitignore|*/.npmignore)
        full=true; docs=true; shared=true ;;
      # Nothing else imports these, so their own tests cover a change to them.
      examples/*|actions/*|tools/*)
        full=true; docs=true
        root=${path%%/*}
        case " $roots " in *" $root "*) ;; *) roots="$roots $root" ;; esac ;;
      *) full=true; docs=true; shared=true ;;
    esac
  done < "$changed"
  if [ "$shared" = false ] && [ -n "$roots" ]; then
    tests=${roots# }
  fi
fi
printf 'full=%s\ndocs=%s\ntests=%s\n' "$full" "$docs" "$tests" >> "$GITHUB_OUTPUT"
