#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 首次部署初始化
# 为指定环境创建 Cloudflare 资源并设置 secrets
# 用法: ./scripts/setup.sh [dev|production|all]

ENV="${1:-all}"
echo "=== MeiGallery 初始化 (环境: $ENV) ==="

# 检查 wrangler
if ! command -v wrangler &> /dev/null; then
  echo "错误: 未找到 wrangler CLI，请先安装: npm install -g wrangler"
  exit 1
fi
if ! wrangler whoami &> /dev/null; then
  echo "错误: 未登录 Cloudflare，请先执行: wrangler login"
  exit 1
fi

create_resources() {
  local env_name=$1
  local suffix=""
  local env_flag=""

  if [ "$env_name" = "dev" ]; then
    suffix="-dev"
    env_flag="--env dev"
  fi

  echo ""
  echo "--- [$env_name] 创建 D1 数据库 ---"
  echo "执行: wrangler d1 create meigallery-db${suffix}"
  echo "⚠ 将返回的 database_id 填入 packages/api/wrangler.toml"
  if [ "$env_name" = "dev" ]; then
    echo "  → 填入 [env.dev.d1_databases] 下的 database_id"
  else
    echo "  → 填入顶层 [[d1_databases]] 下的 database_id"
  fi
  echo ""

  echo "--- [$env_name] 创建 R2 存储桶 ---"
  echo "执行: wrangler r2 bucket create meigallery-media${suffix}"
  echo ""

  echo "--- [$env_name] 设置 Secrets ---"
  echo "在 packages/api 目录下执行："
  echo "  wrangler secret put SESSION_SECRET ${env_flag}"
  echo "  wrangler secret put TURNSTILE_SECRET_KEY ${env_flag}"
  echo "  wrangler secret put STREAM_ACCOUNT_ID ${env_flag}"
  echo "  wrangler secret put STREAM_API_TOKEN ${env_flag}"
  echo "  wrangler secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT ${env_flag}"
  echo ""
}

if [ "$ENV" = "all" ] || [ "$ENV" = "production" ]; then
  create_resources "production"
fi

if [ "$ENV" = "all" ] || [ "$ENV" = "dev" ]; then
  create_resources "dev"
fi

echo "--- GitHub Actions Secrets ---"
echo "在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加："
echo "  CLOUDFLARE_API_TOKEN  — Cloudflare API Token（权限: Workers Scripts:Edit, D1:Edit, R2:Edit）"
echo "  CLOUDFLARE_ACCOUNT_ID — Cloudflare Account ID（Dashboard 右侧栏可见）"
echo ""

echo "--- 初始化种子数据 ---"
echo "D1 migrations 会自动创建 membership_levels 和 settings 表数据"
echo "还需手动创建 Owner 账户："
echo "  1. 注册: POST /api/auth/register"
echo "  2. 修改角色: 通过 D1 控制台将 users 表中 role 改为 'owner'"
echo ""

echo "--- 完成后 ---"
echo "开发环境: ./scripts/deploy.sh dev"
echo "生产环境: ./scripts/deploy.sh production（当前仓库不启用 GitHub Actions 自动生产部署）"
