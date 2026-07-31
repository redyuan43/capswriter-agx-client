#!/usr/bin/env bash
set -euo pipefail

WORKFLOW="daily.yml"
REF="main"
WAIT_FOR_COMPLETION=1
DRY_RUN=0
POLL_ATTEMPTS=30
POLL_INTERVAL_SECONDS=2

usage() {
  cat <<'EOF'
Usage: scripts/trigger-daily-build.sh [options]

Triggers the Daily AppImages GitHub Actions workflow, waits for the matching
run by default, and prints the published daily prerelease.

Options:
  --ref REF    Build another remote branch or tag instead of main.
  --no-wait    Exit after GitHub accepts the workflow dispatch.
  --dry-run    Validate access and print what would be triggered.
  -h, --help   Show this help message.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      REF="${2:?missing value for --ref}"
      shift 2
      ;;
    --no-wait)
      WAIT_FOR_COMPLETION=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is unavailable: $1" >&2
    exit 1
  fi
}

require_command git
require_command gh

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Run this script inside the capswriter-agx-client Git repository." >&2
  exit 1
}
cd "$REPO_ROOT"

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh workflow view "$WORKFLOW" --repo "$REPOSITORY" >/dev/null

TARGET_SHA="$(gh api "repos/${REPOSITORY}/commits/${REF}" --jq .sha)"
SHORT_SHA="${TARGET_SHA:0:7}"

echo "Repository: ${REPOSITORY}"
echo "Workflow:   ${WORKFLOW}"
echo "Reference:  ${REF}"
echo "Commit:     ${TARGET_SHA}"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run passed. No workflow was triggered."
  echo "Command: gh workflow run ${WORKFLOW} --repo ${REPOSITORY} --ref ${REF}"
  exit 0
fi

BEFORE_RUN_ID="$(
  gh run list \
    --repo "$REPOSITORY" \
    --workflow "$WORKFLOW" \
    --event workflow_dispatch \
    --branch "$REF" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId // 0'
)"

echo "Triggering daily build..."
gh workflow run "$WORKFLOW" --repo "$REPOSITORY" --ref "$REF"

if [ "$WAIT_FOR_COMPLETION" -ne 1 ]; then
  echo "Workflow dispatch accepted."
  echo "List runs with: gh run list --repo ${REPOSITORY} --workflow ${WORKFLOW} --limit 5"
  exit 0
fi

RUN_ID=""
RUN_URL=""
for ((attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1)); do
  run="$(
    gh run list \
      --repo "$REPOSITORY" \
      --workflow "$WORKFLOW" \
      --event workflow_dispatch \
      --branch "$REF" \
      --limit 10 \
      --json databaseId,headSha,url \
      --jq ".[] | select(.databaseId != ${BEFORE_RUN_ID} and .headSha == \"${TARGET_SHA}\") | [.databaseId, .url] | @tsv" \
      | head -n 1
  )"
  if [ -n "$run" ]; then
    IFS=$'\t' read -r RUN_ID RUN_URL <<< "$run"
    break
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

if [ -z "$RUN_ID" ]; then
  echo "GitHub accepted the dispatch, but the matching workflow run was not found." >&2
  echo "Inspect runs with: gh run list --repo ${REPOSITORY} --workflow ${WORKFLOW}" >&2
  exit 1
fi

echo "Run ID:     ${RUN_ID}"
echo "Run URL:    ${RUN_URL}"
echo "Waiting for the daily build and prerelease..."
gh run watch "$RUN_ID" --repo "$REPOSITORY" --exit-status --interval 15

RELEASE_TAG="$(
  gh release list \
    --repo "$REPOSITORY" \
    --limit 100 \
    --json tagName,isPrerelease \
    --jq ".[] | select(.isPrerelease and (.tagName | startswith(\"daily-\") and endswith(\"-${SHORT_SHA}\"))) | .tagName" \
    | head -n 1
)"

if [ -z "$RELEASE_TAG" ]; then
  echo "Workflow succeeded, but no daily prerelease was found for ${SHORT_SHA}." >&2
  exit 1
fi

RELEASE_URL="$(gh release view "$RELEASE_TAG" --repo "$REPOSITORY" --json url --jq .url)"
echo "Daily build completed successfully."
echo "Release tag: ${RELEASE_TAG}"
echo "Release URL: ${RELEASE_URL}"
echo "Assets:"
gh release view "$RELEASE_TAG" --repo "$REPOSITORY" --json assets --jq '.assets[].name' \
  | sed 's/^/  - /'
