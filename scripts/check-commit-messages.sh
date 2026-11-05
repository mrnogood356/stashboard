#!/usr/bin/env bash
# Every commit in BASE..HEAD (merges aside) starts with a Conventional
# Commits type, so release-please can build the release notes and the
# in-app "What's new" from them. Only feat and fix show up there; the
# others (chore, docs, test…) are accepted and left out.
set -euo pipefail

base="$1"
head="$2"
pattern='^(feat|fix|perf|refactor|revert|docs|style|test|build|ci|chore)(\([a-z0-9._/-]+\))?!?: .+'

bad=0
while IFS=$'\t' read -r sha subject; do
  [ -z "$sha" ] && continue
  if ! [[ "$subject" =~ $pattern ]]; then
    echo "::error::${sha:0:7} \"$subject\" doesn't start with a type such as feat: or fix:"
    bad=1
  fi
done < <(git log --no-merges --format='%H%x09%s' "$base..$head")

if [ "$bad" -ne 0 ]; then
  cat <<'HELP'
Start each commit message with a type, for example:
  feat(search): find studios the catalog's search misses
  fix(player): a click no longer pauses
  chore: tidy the tests
feat and fix commits become the release notes and What's new.
HELP
  exit 1
fi
echo "Every commit starts with a type."
