#!/usr/bin/env bash
# Emit a "## Issues resolved" markdown section for the release notes: the issues
# closed by the PRs merged between the previous PUBLISHED GitHub release and TAG.
#
# Used by .github/workflows/release.yml (appended to NOTES.md before the draft is
# created); runs anywhere `gh` is authenticated, so it is locally testable:
#
#   scripts/release-issues-section.sh HilbertraumAI/HilbertRaum master
#
# How it maps the range to issues (read-only API calls throughout):
#   1. previous release  = latest published release (drafts don't count — same
#      baseline GitHub's own generated notes use, so the two sections agree).
#   2. PRs in the range  = compare PREV...TAG, then each commit's associated PRs
#      (repos/…/commits/{sha}/pulls). Robust against both squash merges and true
#      merge commits — parsing "(#N)" out of subjects would miss the latter.
#   3. issues per PR     = closingIssuesReferences via GraphQL: the linked issues
#      GitHub itself tracks from "Fixes #N"-style keywords in the PR body.
#
# Prints nothing (exit 0) when there is no baseline release or no linked issues —
# the caller just gets no section. Exits non-zero on API failure; the workflow
# step downgrades that to a warning so notes can never block a release build.
set -euo pipefail

REPO="${1:?usage: release-issues-section.sh OWNER/REPO TAG}"
TAG="${2:?usage: release-issues-section.sh OWNER/REPO TAG}"

PREV=$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)
if [ -z "$PREV" ] || [ "$PREV" = "$TAG" ]; then
  exit 0 # first release, or a re-run after this tag already published
fi

PRS=$(gh api --paginate "repos/$REPO/compare/$PREV...$TAG" -q '.commits[].sha' |
  while read -r sha; do
    gh api "repos/$REPO/commits/$sha/pulls" -q '.[].number'
  done | sort -un)
[ -n "$PRS" ] || exit 0

TAB=$(printf '\t')
ISSUES=$(for pr in $PRS; do
  gh api graphql \
    -F owner="${REPO%/*}" -F name="${REPO#*/}" -F pr="$pr" \
    -f query='query($owner:String!,$name:String!,$pr:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$pr){
            closingIssuesReferences(first:50){nodes{number title}}}}}' \
    -q '.data.repository.pullRequest.closingIssuesReferences.nodes[]
        | [(.number|tostring), .title] | @tsv'
done | sort -t"$TAB" -k1,1n -u)
[ -n "$ISSUES" ] || exit 0

printf '## Issues resolved\n\n'
printf '%s\n' "$ISSUES" | while IFS="$TAB" read -r num title; do
  printf -- '- #%s — %s\n' "$num" "$title"
done
printf '\n'
