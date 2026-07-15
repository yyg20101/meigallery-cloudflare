#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 手动部署脚本。production 的完整验证由 release PR/CI 完成，
# 这里仅执行与本次产物和远端状态直接相关的切换门禁。

if [ "$#" -gt 1 ]; then
  echo "错误: 参数过多。用法：$0 [dev|production]"
  exit 1
fi

ENV="${1:-production}"
if [ "$ENV" != "dev" ] && [ "$ENV" != "production" ]; then
  echo "错误: 无效环境：${ENV}。用法：$0 [dev|production]"
  exit 1
fi

IS_PRODUCTION=false
if [ "$ENV" = "production" ]; then
  IS_PRODUCTION=true
fi

PNPM=(corepack pnpm)
GIT_COMMIT="$(git rev-parse HEAD)"
ATTRIBUTION_CUTOVER=false

echo "=== MeiGallery 部署 (环境: $ENV) ==="

if [ "$IS_PRODUCTION" = "false" ]; then
  ENV_ARGS=(--env dev)
  D1_DB="meigallery-db-dev"
  echo "开发环境部署：Worker、D1、R2 使用独立 dev 资源，广告平台网络保持禁用。"
else
  ENV_ARGS=(--env "")
  D1_DB="meigallery-db"

  if [ "$(git branch --show-current)" != "main" ]; then
    echo "错误: production 只允许从 main 分支部署。"
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "错误: production 部署要求工作区干净。"
    exit 1
  fi

  echo "生产环境部署"
  echo ""
  read -p "确认部署到生产环境？(y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
  fi
fi

if ! "${PNPM[@]}" --filter @meigallery/api exec wrangler whoami &> /dev/null; then
  echo "错误: 未登录 Cloudflare，请先执行: corepack pnpm --filter @meigallery/api exec wrangler login"
  exit 1
fi

if [ "$IS_PRODUCTION" = "true" ]; then
  echo "[1/9] 执行 production 快速代码门禁..."
  if ! "${PNPM[@]}" verify:quick; then
    echo "生产部署被快速验证阻断，尚未修改 production D1。"
    exit 1
  fi

  echo "读取 production 待执行 migration..."
  UNAPPLIED_MIGRATIONS="$("${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations list "$D1_DB" "${ENV_ARGS[@]}" --remote 2>&1)"

  if [ -f "packages/api/migrations/0017_cases_cleanup.sql" ] && [ "${ALLOW_CASES_CLEANUP_MIGRATION:-}" != "true" ]; then
    if [[ "$UNAPPLIED_MIGRATIONS" == *"0017_cases_cleanup"* ]]; then
      echo "错误: 0017_cases_cleanup.sql 仍在待执行 migration 列表中。"
      echo "请先完成 R2 Cases dry-run、复制和目标对象验证。"
      echo "确认完成后可显式设置 ALLOW_CASES_CLEANUP_MIGRATION=true。"
      exit 1
    fi
  fi

  if [[ "$UNAPPLIED_MIGRATIONS" == *"0051_unified_attribution_expand"* ]]; then
    ATTRIBUTION_CUTOVER=true
    echo "[2/9] 执行通用归因 production preflight..."
    if ! node scripts/verify-attribution-v3-migration.mjs preflight; then
      echo "生产部署被通用归因 production preflight 阻断，尚未备份或修改 production D1。"
      exit 1
    fi

    echo "[3/9] 导出 production D1 备份..."
    node scripts/export-attribution-production-backup.mjs
  else
    echo "[2/9] 0051 已应用，本次为常规发布，跳过一次性归因切换 preflight 和备份。"
  fi

  echo "[4/9] 应用 production D1 Expand migration..."
  "${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations apply "$D1_DB" "${ENV_ARGS[@]}" --remote
else
  echo "[1/6] 运行 API 测试..."
  "${PNPM[@]}" --filter @meigallery/api test

  echo "[2/6] 执行 API Worker dry-run..."
  "${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}" --dry-run --outdir=dist

  echo "[3/6] 构建 Web Worker..."
  "${PNPM[@]}" --filter @meigallery/web build

  echo "[4/6] 应用 dev D1 migration..."
  "${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations apply "$D1_DB" "${ENV_ARGS[@]}" --remote
fi

echo "部署 API Worker..."
"${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"

echo "部署 Web Worker..."
"${PNPM[@]}" --filter @meigallery/web exec wrangler deploy "${ENV_ARGS[@]}" --var "RELEASE_COMMIT:${GIT_COMMIT}"

if [ "$IS_PRODUCTION" = "true" ]; then
  if [ "$ATTRIBUTION_CUTOVER" = "true" ]; then
    echo "确认 production Workflow 已由新 API Worker 创建..."
    "${PNPM[@]}" --filter @meigallery/api exec wrangler workflows describe meigallery-ad-platform-verification --env "" > /dev/null

    echo "[7/9] 幂等回填历史标准事实..."
    node scripts/verify-attribution-v3-migration.mjs backfill --apply

    echo "[8/9] 对账通用归因事实且确认零历史重投..."
    node scripts/verify-attribution-v3-migration.mjs reconcile
  else
    echo "[7/9] 常规发布不重复执行历史回填。"
    echo "[8/9] 常规发布不重复执行一次性迁移对账。"
  fi

  echo "校验 production API/Web release identity..."
  env -u VERIFY_RELEASE_ALLOW_BRANCH node scripts/verify-release.mjs assert-production-identity

  echo "[9/9] 执行 production SEO 和基础可用性烟测..."
  node scripts/verify-production-seo.mjs
else
  echo "[5/6] API/Web Worker 已部署。"
  echo "[6/6] dev 使用 Workers dev 子域，跳过 production smoke。"
fi

echo ""
echo "=== 部署完成 ==="
if [ "$IS_PRODUCTION" = "false" ]; then
  echo "前端: https://meigallery-web-dev.<你的子域>.workers.dev"
  echo "API:  https://meigallery-api-dev.<你的子域>.workers.dev"
else
  echo "前端: https://616618.xyz"
  echo "前端: https://www.616618.xyz"
  echo "API:  https://api.616618.xyz"
fi
