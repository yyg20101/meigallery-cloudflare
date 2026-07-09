#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 首次部署初始化
# 创建 Cloudflare 资源并提示配置生产/dev secrets
# 用法: ./scripts/setup.sh [dev|production|all]

ENV="${1:-all}"
if [ "$ENV" != "dev" ] && [ "$ENV" != "production" ] && [ "$ENV" != "all" ]; then
  echo "错误: 无效环境：${ENV}。用法：$0 [dev|production|all]"
  exit 1
fi

echo "=== MeiGallery 初始化 (环境: $ENV) ==="

# 检查 wrangler
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
  WRANGLER_CMD="wrangler"
else
  WRANGLER=(corepack pnpm --filter @meigallery/api exec wrangler)
  WRANGLER_CMD="corepack pnpm --filter @meigallery/api exec wrangler"
fi

if ! "${WRANGLER[@]}" --version &> /dev/null; then
  echo "错误: 未找到 Wrangler CLI，请先安装依赖: corepack pnpm install"
  exit 1
fi
if ! "${WRANGLER[@]}" whoami &> /dev/null; then
  echo "错误: 未登录 Cloudflare，请先执行: ${WRANGLER_CMD} login"
  exit 1
fi

print_production_resources() {
  echo ""
  echo "--- 创建生产 D1 数据库 ---"
  echo "执行: ${WRANGLER_CMD} d1 create meigallery-db"
  echo "⚠ 将返回的 database_id 填入 packages/api/wrangler.toml 的顶层 [[d1_databases]]"
  echo ""

  echo "--- 创建生产 R2 存储桶 ---"
  echo "执行: ${WRANGLER_CMD} r2 bucket create meigallery-media"
  echo ""

  echo "--- 创建生产 Meta CAPI Queue（启用 CAPI 时需要） ---"
  echo "执行: ${WRANGLER_CMD} queues create meigallery-meta-capi"
  echo ""
}

print_dev_resources() {
  echo ""
  echo "--- 创建 dev D1 数据库 ---"
  echo "执行: ${WRANGLER_CMD} d1 create meigallery-db-dev"
  echo "⚠ 将返回的 database_id 填入 packages/api/wrangler.toml 的 [env.dev] [[d1_databases]]"
  echo ""

  echo "--- 创建 dev R2 存储桶 ---"
  echo "执行: ${WRANGLER_CMD} r2 bucket create meigallery-media-dev"
  echo ""

  echo "--- 创建 dev Meta CAPI Queue（启用 CAPI 或发布预演时需要） ---"
  echo "执行: ${WRANGLER_CMD} queues create meigallery-meta-capi-dev"
  echo ""
  echo "当前 dev Worker 使用独立 D1/R2/Queue，不再复用生产资源。"
  echo ""
}

print_secrets() {
  local env_name=$1
  local env_flag=""

  if [ "$env_name" = "dev" ]; then
    env_flag="--env dev"
  fi

  echo ""
  echo "--- [$env_name] 设置 Secrets ---"
  echo "在仓库根目录执行："
  echo "  ${WRANGLER_CMD} secret put SESSION_SECRET ${env_flag}"
  echo "  ${WRANGLER_CMD} secret put TURNSTILE_SECRET_KEY ${env_flag}"
  echo "  ${WRANGLER_CMD} secret put STREAM_ACCOUNT_ID ${env_flag}"
  echo "  ${WRANGLER_CMD} secret put STREAM_API_TOKEN ${env_flag}"
  echo "  ${WRANGLER_CMD} secret put TELEGRAM_BOT_TOKEN_OPS_GALLERY_BOT ${env_flag}"
  echo "  # 可选：sourceBotKey=ops_case_bot 时配置"
  echo "  ${WRANGLER_CMD} secret put TELEGRAM_BOT_TOKEN_OPS_CASE_BOT ${env_flag}"
  echo ""
}

if [ "$ENV" = "all" ] || [ "$ENV" = "production" ]; then
  print_production_resources
  print_secrets "production"
fi

if [ "$ENV" = "all" ] || [ "$ENV" = "dev" ]; then
  print_dev_resources
  print_secrets "dev"
fi

echo "--- CI 状态 ---"
echo "当前 GitHub Actions 只运行测试、类型检查和构建验证，不负责生产部署。"
echo "生产部署使用本地手动 wrangler 命令，不需要配置 GitHub Actions 部署密钥。"
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
