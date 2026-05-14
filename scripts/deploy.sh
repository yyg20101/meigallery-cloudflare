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

# 检查 wrangler 是否可用
if ! command -v wrangler &> /dev/null; then
  echo "错误: 未找到 wrangler CLI，请先安装: npm install -g wrangler"
  exit 1
fi

# 检查是否已登录
if ! wrangler whoami &> /dev/null; then
  echo "错误: 未登录 Cloudflare，请先执行: wrangler login"
  exit 1
fi

# 根据环境设置 wrangler 参数
if [ "$IS_PRODUCTION" = "false" ]; then
  ENV_FLAG="--env dev"
  D1_DB="meigallery-db"
  echo "⚠ 开发环境部署 — Worker 名称带 -dev 后缀"
else
  ENV_FLAG=""
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
echo "--- 步骤 1/6: 运行测试 ---"
pnpm --filter @meigallery/api test

echo ""
echo "--- 步骤 2/6: API Worker 构建预检 ---"
cd packages/api
wrangler deploy $ENV_FLAG --dry-run --outdir=dist
cd ../..

echo ""
echo "--- 步骤 3/6: 构建前端 ---"
pnpm --filter @meigallery/web build

echo ""
echo "--- 步骤 4/6: 执行 D1 数据库迁移 ---"
if [ "$IS_PRODUCTION" = "true" ] && [ -f "packages/api/migrations/0017_cases_cleanup.sql" ] && [ "${ALLOW_CASES_CLEANUP_MIGRATION:-}" != "true" ]; then
  echo "错误: 检测到 packages/api/migrations/0017_cases_cleanup.sql。"
  echo "此迁移会将真实案例 R2 key 从 testimonials/ 切换到 cases/。"
  echo "请先执行 R2 Cases dry-run、复制和目标对象验证，再执行 D1 migration。"
  echo "如果 0017 已确认执行完成，或已完成 R2 复制验证并准备执行迁移，可显式设置 ALLOW_CASES_CLEANUP_MIGRATION=true 绕过。"
  exit 1
fi
cd packages/api
wrangler d1 migrations apply "$D1_DB" $ENV_FLAG --remote
cd ../..

echo ""
echo "--- 步骤 5/6: 部署 API Worker ---"
cd packages/api
wrangler deploy $ENV_FLAG
cd ../..

echo ""
echo "--- 步骤 6/6: 部署 Web Worker ---"
cd packages/web
wrangler deploy $ENV_FLAG
cd ../..

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
