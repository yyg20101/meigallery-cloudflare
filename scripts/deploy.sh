#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 一键部署脚本
# 用法: ./scripts/deploy.sh [dev|production]

ENV="${1:-production}"
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

echo ""
echo "--- 步骤 1/4: 执行 D1 数据库迁移 ---"
cd packages/api
wrangler d1 migrations apply meigallery-db ${ENV:+--env $ENV} --remote
cd ../..

echo ""
echo "--- 步骤 2/4: 构建前端 ---"
pnpm --filter @meigallery/web exec nuxt build

echo ""
echo "--- 步骤 3/4: 部署 API Worker ---"
cd packages/api
if [ "$ENV" = "dev" ]; then
  wrangler deploy --env dev
else
  wrangler deploy
fi
cd ../..

echo ""
echo "--- 步骤 4/4: 部署 Web Worker ---"
cd packages/web
if [ "$ENV" = "dev" ]; then
  wrangler deploy --env dev
else
  wrangler deploy
fi
cd ../..

echo ""
echo "=== 部署完成 ==="
echo "前端: https://meigallery.com"
echo "API:  https://api.meigallery.com"
