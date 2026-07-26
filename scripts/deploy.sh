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

  if [ -f "packages/api/migrations/0017_cases_cleanup.sql" ] && [ "${ALLOW_CASES_CLEANUP_MIGRATION:-}" != "true" ]; then
    if [[ "$UNAPPLIED_MIGRATIONS" == *"0017_cases_cleanup"* ]]; then
      echo "错误: 0017_cases_cleanup.sql 需要先完成人工 R2 核验。"
      exit 1
    fi
  fi

  if [[ "$UNAPPLIED_MIGRATIONS" == *"0060_attribution_control_plane_cleanup"* ]]; then
    echo "[API] 验证待执行的归因控制面清理 migration..."
    node --test packages/api/migrations/0060_attribution_control_plane_cleanup.test.mjs
  fi

  if [ "$IS_PRODUCTION" = "true" ]; then
    if [[ "$UNAPPLIED_MIGRATIONS" == *"0052_unified_attribution_contract"* ]] \
      || [[ "$UNAPPLIED_MIGRATIONS" == *"0053_attribution_privacy_policy"* ]] \
      || [[ "$UNAPPLIED_MIGRATIONS" == *"0055_attribution_tracking_integrity"* ]] \
      || [[ "$UNAPPLIED_MIGRATIONS" == *"0056_attribution_fact_source_integrity"* ]] \
      || [[ "$UNAPPLIED_MIGRATIONS" == *"0057_contact_aggregate_integrity"* ]] \
      || [[ "$UNAPPLIED_MIGRATIONS" == *"0060_attribution_control_plane_cleanup"* ]]; then
      echo "[API] 高风险 migration 待执行，导出 production D1 备份..."
      node scripts/export-production-d1-backup.mjs
    fi
  fi

  if [ "$IS_PRODUCTION" = "true" ]; then
    RELEASE_TAG="production-${GIT_COMMIT:0:12}-$(date -u +%Y%m%d%H%M%S)"
    echo "[API] 上传待激活 Version..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler versions upload "${ENV_ARGS[@]}" \
      --tag "$RELEASE_TAG" \
      --message "production ${GIT_COMMIT}" \
      --var "RELEASE_COMMIT:${GIT_COMMIT}"
  fi

  echo "[API] 应用 D1 migration..."
  "${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations apply "$D1_DB" "${ENV_ARGS[@]}" --remote

  if [ "$IS_PRODUCTION" = "true" ]; then
    echo "[API] 激活已上传 Version..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler versions deploy "${ENV_ARGS[@]}" \
      --version-tag "${RELEASE_TAG}@100%" \
      --message "production ${GIT_COMMIT}" \
      --yes
  else
    echo "[API] 部署 Worker..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"
  fi
fi

if [ "$RUN_WEB" = "true" ]; then
  echo "[Web] 部署 Worker..."
  "${PNPM[@]}" --filter @meigallery/web exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"
fi

if [ "$IS_PRODUCTION" = "true" ]; then
  echo "[生产] 验证受影响服务..."
  node scripts/verify-production.mjs "$SCOPE"
  if [ "$RUN_WEB" = "true" ]; then
    node scripts/verify-production-seo.mjs
  fi
else
  echo "dev 使用独立资源，不请求真实广告平台。"
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
