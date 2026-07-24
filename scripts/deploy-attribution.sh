#!/usr/bin/env bash
set -euo pipefail

PNPM=(corepack pnpm)
PACKAGE="@meigallery/attribution"
DATABASE="meigallery-attribution-db"

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
"${PNPM[@]}" --filter "$PACKAGE" deploy
