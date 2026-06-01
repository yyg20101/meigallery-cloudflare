#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 一键部署脚本
# 用法: ./scripts/deploy.sh [dev|production]
# dev 和 production 均为手动部署；GitHub Actions 当前只做 CI 验证

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

echo "=== MeiGallery 部署 (环境: $ENV) ==="

if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  PNPM=(corepack pnpm)
fi

# 检查是否已登录
if ! "${PNPM[@]}" --filter @meigallery/api exec wrangler whoami &> /dev/null; then
  echo "错误: 未登录 Cloudflare，请先执行: corepack pnpm --filter @meigallery/api exec wrangler login"
  exit 1
fi

# 根据环境设置 wrangler 参数
if [ "$IS_PRODUCTION" = "false" ]; then
  ENV_ARGS=(--env dev)
  D1_DB="meigallery-db"
  echo "⚠ 开发环境部署 — Worker 名称带 -dev 后缀"
else
  ENV_ARGS=(--env "")
  D1_DB="meigallery-db"
  echo "🚀 生产环境部署"
  echo ""
  read -p "确认部署到生产环境？(y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
  fi
fi

echo ""
echo "--- 步骤 1/7: 运行测试 ---"
"${PNPM[@]}" --filter @meigallery/api test

echo ""
echo "--- 步骤 2/7: API Worker 构建预检 ---"
"${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}" --dry-run --outdir=dist

echo ""
echo "--- 步骤 3/7: 构建前端 ---"
"${PNPM[@]}" --filter @meigallery/web build

echo ""
echo "--- 步骤 4/7: 执行 D1 数据库迁移 ---"
if [ "$IS_PRODUCTION" = "true" ] && [ -f "packages/api/migrations/0017_cases_cleanup.sql" ] && [ "${ALLOW_CASES_CLEANUP_MIGRATION:-}" != "true" ]; then
  UNAPPLIED_MIGRATIONS="$("${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations list "$D1_DB" "${ENV_ARGS[@]}" --remote 2>&1)"
  if [[ "$UNAPPLIED_MIGRATIONS" == *"0017_cases_cleanup"* ]]; then
    echo "错误: 0017_cases_cleanup.sql 仍在待执行迁移列表中。"
    echo "此迁移会将真实案例 R2 key 从 testimonials/ 切换到 cases/。"
    echo "请先执行 R2 Cases dry-run、复制和目标对象验证，再执行 D1 migration。"
    echo "如果已完成 R2 复制验证并准备执行迁移，可显式设置 ALLOW_CASES_CLEANUP_MIGRATION=true 绕过。"
    exit 1
  fi
  echo "0017_cases_cleanup.sql 已应用或不在待执行列表中，继续生产迁移检查。"
fi
"${PNPM[@]}" --filter @meigallery/api exec wrangler d1 migrations apply "$D1_DB" "${ENV_ARGS[@]}" --remote

echo ""
echo "--- 步骤 5/7: 部署 API Worker ---"
"${PNPM[@]}" --filter @meigallery/api exec wrangler deploy "${ENV_ARGS[@]}"

echo ""
echo "--- 步骤 6/7: 部署 Web Worker ---"
"${PNPM[@]}" --filter @meigallery/web exec wrangler deploy "${ENV_ARGS[@]}"

echo ""
echo "--- 步骤 7/7: 部署后 SEO 校验 ---"
if [ "$IS_PRODUCTION" = "true" ]; then
  node scripts/verify-production-seo.mjs
else
  echo "开发环境使用 Workers dev 子域，跳过生产 SEO 校验。"
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
