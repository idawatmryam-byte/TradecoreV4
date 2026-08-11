#!/usr/bin/env bash
# TradeCore Pro deployment launcher (stage 1).
#
# This file deliberately does not perform migrations, builds, restarts, or
# verification. It resolves one exact reviewed commit, extracts the deployment
# implementation from that commit, and replaces this process with it. Therefore
# a shell started from an older checkout cannot continue running stale updater
# logic after the repository advances.
set -Eeuo pipefail

log() { printf '\n\033[1;36m[update:stage1]\033[0m %s\n' "$*"; }

if [[ -n "${TRADECORE_REPO_ROOT:-}" ]]; then
  REPO_ROOT="$(cd "$TRADECORE_REPO_ROOT" && pwd)"
else
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
cd "$REPO_ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to deploy over tracked local changes. Commit or stash them first." >&2
  exit 1
fi

DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_REMOTE_BRANCH="${DEPLOY_REMOTE_BRANCH:-main}"
TARGET_REF="${1:-${DEPLOY_TARGET_REF:-${DEPLOY_REMOTE}/${DEPLOY_REMOTE_BRANCH}}}"

log "fetching ${DEPLOY_REMOTE}/${DEPLOY_REMOTE_BRANCH}"
git fetch "$DEPLOY_REMOTE" "$DEPLOY_REMOTE_BRANCH"

TARGET_COMMIT="$(git rev-parse --verify --end-of-options "${TARGET_REF}^{commit}")"
git cat-file -e "${TARGET_COMMIT}^{commit}"
PREVIOUS_COMMIT="$(git rev-parse --verify HEAD^{commit})"

if ! git merge-base --is-ancestor "$PREVIOUS_COMMIT" "$TARGET_COMMIT"; then
  echo "Target $TARGET_COMMIT is not a fast-forward from current commit $PREVIOUS_COMMIT." >&2
  exit 1
fi

TARGET_SCRIPT_PATH="scripts/deploy/deploy-target.sh"
TARGET_SCRIPT_BLOB="$(git rev-parse --verify --end-of-options "${TARGET_COMMIT}:${TARGET_SCRIPT_PATH}")"
DEPLOY_BUNDLE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tradecore-deploy-target.XXXXXX")"

cleanup() { rm -rf -- "$DEPLOY_BUNDLE_DIR"; }
trap cleanup EXIT

git archive "$TARGET_COMMIT" scripts/deploy | tar -x -C "$DEPLOY_BUNDLE_DIR"
if [[ ! -f "$DEPLOY_BUNDLE_DIR/$TARGET_SCRIPT_PATH" ]]; then
  echo "Target revision does not contain $TARGET_SCRIPT_PATH" >&2
  exit 1
fi

log "resolved target=$TARGET_COMMIT previous=$PREVIOUS_COMMIT stage2_blob=$TARGET_SCRIPT_BLOB"
log "transferring control to deployment logic from the target revision"

# Stage 2 owns cleanup after exec replaces this launcher.
trap - EXIT
exec env \
  TRADECORE_REPO_ROOT="$REPO_ROOT" \
  TRADECORE_PREVIOUS_COMMIT="$PREVIOUS_COMMIT" \
  TRADECORE_TARGET_COMMIT="$TARGET_COMMIT" \
  TRADECORE_TARGET_SCRIPT_BLOB="$TARGET_SCRIPT_BLOB" \
  TRADECORE_DEPLOY_BUNDLE_DIR="$DEPLOY_BUNDLE_DIR" \
  bash "$DEPLOY_BUNDLE_DIR/$TARGET_SCRIPT_PATH"
