#!/usr/bin/env bash
set -euo pipefail

# 正式发布依赖 main PR 的完整 CI；本脚本只做受影响 Worker 的必要检查、
# migration、部署和生产烟测，不重复执行全量测试与 E2E。

if [ "$#" -gt 2 ]; then
  echo "错误: 参数过多。用法：$0 [dev|production] [api|web|all]"
  exit 1
fi

ENV="${1:-production}"
SCOPE="${2:-all}"
if [ "$ENV" != "dev" ] && [ "$ENV" != "production" ]; then
  echo "错误: 无效环境：${ENV}"
  exit 1
fi
if [ "$SCOPE" != "api" ] && [ "$SCOPE" != "web" ] && [ "$SCOPE" != "all" ]; then
  echo "错误: 无效部署范围：${SCOPE}"
  exit 1
fi

RUN_API=false
RUN_WEB=false
if [ "$SCOPE" = "api" ] || [ "$SCOPE" = "all" ]; then RUN_API=true; fi
if [ "$SCOPE" = "web" ] || [ "$SCOPE" = "all" ]; then RUN_WEB=true; fi

IS_PRODUCTION=false
ENV_ARGS=(--env dev)
D1_DB="meigallery-db-dev"
if [ "$ENV" = "production" ]; then
  IS_PRODUCTION=true
  ENV_ARGS=(--env "")
  D1_DB="meigallery-db"
fi

PNPM=(corepack pnpm)
GIT_COMMIT="$(git rev-parse HEAD)"
API_RELEASE_TAG=""
WEB_RELEASE_TAG=""
HAS_PENDING_MIGRATIONS=false
WALLET1_MIGRATION_PENDING=false

echo "=== MeiGallery 部署 (环境: $ENV, 范围: $SCOPE) ==="

if [ "$IS_PRODUCTION" = "true" ]; then
  if [ "$(git branch --show-current)" != "main" ]; then
    echo "错误: production 只允许从 main 分支部署。"
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "错误: production 部署要求工作区干净。"
    exit 1
  fi
fi

if ! "${PNPM[@]}" --filter @meigallery/api exec wrangler whoami &> /dev/null; then
  echo "错误: 未登录 Cloudflare，请先执行 wrangler login。"
  exit 1
fi

if [ "$RUN_API" = "true" ]; then
  echo "[API] 类型检查..."
  "${PNPM[@]}" --filter @meigallery/api exec tsc --noEmit
fi

if [ "$RUN_WEB" = "true" ]; then
  echo "[Web] 构建 Worker..."
  "${PNPM[@]}" --filter @meigallery/web build
fi

if [ "$RUN_API" = "true" ]; then
  echo "[API] 读取待执行 migration..."
  UNAPPLIED_MIGRATIONS="$("${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations list "$D1_DB" "${ENV_ARGS[@]}" --remote 2>&1)"
  if [[ "$UNAPPLIED_MIGRATIONS" == *".sql"* ]]; then
    HAS_PENDING_MIGRATIONS=true
  fi

  if [ -f "packages/api/migrations/0017_cases_cleanup.sql" ] && [ "${ALLOW_CASES_CLEANUP_MIGRATION:-}" != "true" ]; then
    if [[ "$UNAPPLIED_MIGRATIONS" == *"0017_cases_cleanup"* ]]; then
      echo "错误: 0017_cases_cleanup.sql 需要先完成人工 R2 核验。"
      exit 1
    fi
  fi

  if [[ "$UNAPPLIED_MIGRATIONS" == *"0077_app_wallet_ledger.sql"* ]]; then
    WALLET1_MIGRATION_PENDING=true
    if [ "$IS_PRODUCTION" = "true" ]; then
      echo "错误: Wallet-1 production migration 尚未获准；必须先关闭 OQ-018、OQ-020、OQ-024 并单独评审生产门禁。"
      exit 1
    fi
    if [ "${ALLOW_WALLET1_DEV_MIGRATIONS:-}" != "true" ]; then
      echo "错误: Wallet-1 dev migration 需要显式设置 ALLOW_WALLET1_DEV_MIGRATIONS=true。"
      exit 1
    fi
    if [ -z "${WALLET1_DEV_READINESS_MANIFEST:-}" ]; then
      echo "错误: Wallet-1 dev migration 需要仓库外的 WALLET1_DEV_READINESS_MANIFEST。"
      exit 1
    fi
    echo "[API] 验证 Wallet-1 dev 迁移前备份与短期清单..."
    node scripts/prepare-dev-wallet1.mjs \
      --confirm-dev="$D1_DB" \
      --validate-manifest="$WALLET1_DEV_READINESS_MANIFEST"
  fi

  if [ "$IS_PRODUCTION" = "true" ] && [ "$HAS_PENDING_MIGRATIONS" = "true" ]; then
    echo "[API] production D1 存在待执行 migration，先导出备份..."
    node scripts/export-production-d1-backup.mjs
  fi
fi

if [ "$IS_PRODUCTION" = "true" ]; then
  RELEASE_TAG_PREFIX="production-${GIT_COMMIT:0:12}-$(date -u +%Y%m%d%H%M%S)"
  if [ "$RUN_API" = "true" ]; then
    API_RELEASE_TAG="${RELEASE_TAG_PREFIX}-api"
    echo "[API] 上传待激活 Version..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler versions upload "${ENV_ARGS[@]}" \
      --tag "$API_RELEASE_TAG" \
      --message "production ${GIT_COMMIT}" \
      --var "RELEASE_COMMIT:${GIT_COMMIT}"
  fi
  if [ "$RUN_WEB" = "true" ]; then
    WEB_RELEASE_TAG="${RELEASE_TAG_PREFIX}-web"
    echo "[Web] 上传待激活 Version..."
    "${PNPM[@]}" --filter @meigallery/web exec wrangler versions upload "${ENV_ARGS[@]}" \
      --tag "$WEB_RELEASE_TAG" \
      --message "production ${GIT_COMMIT}" \
      --var "RELEASE_COMMIT:${GIT_COMMIT}"
  fi
fi

if [ "$RUN_API" = "true" ]; then
  if [ "$HAS_PENDING_MIGRATIONS" = "true" ]; then
    echo "[API] 应用 D1 migration..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations apply "$D1_DB" "${ENV_ARGS[@]}" --remote
  else
    echo "[API] 无待执行 D1 migration，跳过。"
  fi

  if [ "$IS_PRODUCTION" = "true" ]; then
    echo "[API] 激活已上传 Version..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler versions deploy "${ENV_ARGS[@]}" \
      --version-tag "${API_RELEASE_TAG}@100%" \
      --message "production ${GIT_COMMIT}" \
      --yes
  else
    echo "[API] 部署 Worker..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"
  fi
fi

if [ "$RUN_WEB" = "true" ]; then
  if [ "$IS_PRODUCTION" = "true" ]; then
    echo "[Web] 激活已上传 Version..."
    "${PNPM[@]}" --filter @meigallery/web exec wrangler versions deploy "${ENV_ARGS[@]}" \
      --version-tag "${WEB_RELEASE_TAG}@100%" \
      --message "production ${GIT_COMMIT}" \
      --yes
  else
    echo "[Web] 部署 Worker..."
    "${PNPM[@]}" --filter @meigallery/web exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"
  fi
fi

if [ "$IS_PRODUCTION" = "true" ]; then
  echo "[生产] 验证受影响服务..."
  node scripts/verify-production.mjs "$SCOPE"
  if [ "$RUN_WEB" = "true" ]; then
    node scripts/verify-production-seo.mjs
  fi
else
  echo "dev 使用独立资源，不请求真实广告平台。"
  if [ "$RUN_API" = "true" ] && [ "$WALLET1_MIGRATION_PENDING" = "true" ]; then
    echo "[API] 只读验收 Wallet-1 schema、关闭策略与空业务账本..."
    node scripts/verify-dev-wallet1-schema.mjs --confirm-dev="$D1_DB"
  fi
fi

echo ""
echo "=== 部署完成 ==="
if [ "$IS_PRODUCTION" = "true" ]; then
  echo "Web: https://616618.xyz"
  echo "API: https://api.616618.xyz"
else
  echo "Web: meigallery-web-dev Workers dev 子域"
  echo "API: meigallery-api-dev Workers dev 子域"
fi
