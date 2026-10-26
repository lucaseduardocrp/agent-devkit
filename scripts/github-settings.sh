#!/usr/bin/env bash
# Applies the repository settings that cannot live in files: branch rulesets for main
# (.github/rulesets/*.json), merge options, Actions permissions and security features.
# Idempotent: run it again after changing a ruleset file.
#
#   Requires the GitHub CLI signed in as the repository owner (gh auth login).
#   Usage: scripts/github-settings.sh [owner/repo]
set -euo pipefail

repo="${1:-lucaseduardocrp/agent-devkit}"
root="$(cd "$(dirname "$0")/.." && pwd)"

echo "Merge options: squash only, delete merged branches, allow auto-merge"
gh api --method PATCH "repos/$repo" --silent \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F allow_auto_merge=true \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY

echo "Actions: read-only token by default, workflows cannot approve pull requests"
gh api --method PUT "repos/$repo/actions/permissions/workflow" --silent \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false

echo "Actions: workflows of every outside contributor wait for the owner's approval"
gh api --method PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" --silent \
  -f approval_policy=all_external_contributors

echo "Security: Dependabot alerts and fixes, private vulnerability reporting"
gh api --method PUT "repos/$repo/vulnerability-alerts" --silent
gh api --method PUT "repos/$repo/automated-security-fixes" --silent
gh api --method PUT "repos/$repo/private-vulnerability-reporting" --silent

for file in "$root"/.github/rulesets/*.json; do
  name="$(node -p "require(process.argv[1]).name" "$file")"
  id="$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")"
  if [ -n "$id" ]; then
    echo "Ruleset \"$name\": updating ($id)"
    gh api --method PUT "repos/$repo/rulesets/$id" --input "$file" --silent
  else
    echo "Ruleset \"$name\": creating"
    gh api --method POST "repos/$repo/rulesets" --input "$file" --silent
  fi
done

echo "Done."
