#!/usr/bin/env bash
set -euo pipefail

PNPM=(corepack pnpm)
PACKAGE="@meigallery/attribution"
DATABASE="meigallery-attribution-db"
ENVIRONMENT="${1:-}"
MODE="${2:-deploy}"

if [[ "$ENVIRONMENT" != "production" ]]; then
  echo "ATTRIBUTION_DEPLOY_ENV_INVALID"
  exit 1
fi

if [[ "$MODE" != "deploy" && "$MODE" != "bootstrap" ]]; then
  echo "ATTRIBUTION_DEPLOY_MODE_INVALID"
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "ATTRIBUTION_DEPLOY_BRANCH_INVALID"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ATTRIBUTION_DEPLOY_WORKTREE_DIRTY"
  exit 1
fi

if rg -q '00000000-0000-0000-0000-000000000000' \
  packages/attribution/wrangler.toml; then
  echo "ATTRIBUTION_D1_RESOURCE_NOT_PROVISIONED"
  exit 1
fi

"${PNPM[@]}" --filter "$PACKAGE" test
"${PNPM[@]}" --filter "$PACKAGE" typecheck
"${PNPM[@]}" --filter "$PACKAGE" build
"${PNPM[@]}" --filter "$PACKAGE" exec wrangler d1 migrations apply \
  "$DATABASE" --env="" --remote

deploy_attribution() {
  if [[ "$MODE" == "bootstrap" ]]; then
    node scripts/bootstrap-attribution-worker.mjs --apply
    return
  fi
  "${PNPM[@]}" --filter "$PACKAGE" exec wrangler deploy \
    --env="" \
    --strict \
    --message "归因 Worker 常规部署"
}

verify_health() {
  local health
  health="$(
    curl \
      --fail \
      --silent \
      --show-error \
      --retry 6 \
      --retry-all-errors \
      --retry-delay 5 \
      https://track.616618.xyz/health
  )"
  node -e '
    const payload = JSON.parse(process.argv[1])
    if (
      payload.status !== "ok"
      || !["shadow", "bridge", "active"].includes(payload.runtimeMode)
    ) process.exit(1)
  ' "$health"
}

deploy_attribution
verify_health
