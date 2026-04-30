#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 一键部署脚本
# 用法: ./scripts/deploy.sh [dev|production]
# dev 环境手动部署，production 通常由 GitHub Actions 自动触发

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

# 根据环境设置 wrangler 参数
if [ "$ENV" = "dev" ]; then
  ENV_FLAG="--env dev"
  D1_DB="meigallery-db-dev"
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
echo "--- 步骤 1/5: 运行测试 ---"
pnpm --filter @meigallery/api test

echo ""
echo "--- 步骤 2/5: 执行 D1 数据库迁移 ---"
cd packages/api
wrangler d1 migrations apply "$D1_DB" $ENV_FLAG --remote
cd ../..

echo ""
echo "--- 步骤 3/5: 构建前端 ---"
pnpm --filter @meigallery/web build

echo ""
echo "--- 步骤 4/5: 部署 API Worker ---"
cd packages/api
wrangler deploy $ENV_FLAG
cd ../..

echo ""
echo "--- 步骤 5/5: 部署 Web Worker ---"
cd packages/web
wrangler deploy $ENV_FLAG
cd ../..

echo ""
echo "=== 部署完成 ==="
if [ "$ENV" = "dev" ]; then
  echo "前端: https://meigallery-web-dev.<你的子域>.workers.dev"
  echo "API:  https://meigallery-api-dev.<你的子域>.workers.dev"
else
  echo "前端: https://meigallery-web.<你的子域>.workers.dev"
  echo "API:  https://meigallery-api.<你的子域>.workers.dev"
  echo ""
  echo "绑定自定义域名后："
  echo "前端: https://meigallery.com"
  echo "API:  https://api.meigallery.com"
fi
