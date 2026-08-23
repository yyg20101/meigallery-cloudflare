#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 首次部署初始化
# 创建 Cloudflare 资源并提示配置 production/dev secrets
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

create_queue() {
  local queue_name=$1
  local attempt

  if "${WRANGLER[@]}" queues info "$queue_name" &> /dev/null; then
    echo "Queue ${queue_name} 已确认存在"
    return 0
  fi

  if ! "${WRANGLER[@]}" queues create "$queue_name" &> /dev/null; then
    echo "Queue ${queue_name} 创建请求未确认成功，继续检查远端状态..."
  fi

  for attempt in 1 2 3 4 5 6; do
    if "${WRANGLER[@]}" queues info "$queue_name" &> /dev/null; then
      echo "Queue ${queue_name} 已确认存在"
      return 0
    fi
    sleep 2
  done

  echo "错误: 创建 Queue ${queue_name} 失败"
  return 1
}

create_application_queues() {
  local suffix=$1
  local base_name

  for base_name in \
    "meigallery-import-zip" \
    "meigallery-app-data-rights-export" \
    "meigallery-app-data-rights-deletion" \
    "meigallery-import-telegram"; do
    create_queue "${base_name}${suffix}"
    create_queue "${base_name}${suffix}-dlq"
  done
}

print_production_resources() {
  echo ""
  echo "--- 创建生产 D1 数据库 ---"
  echo "执行: ${WRANGLER_CMD} d1 create meigallery-db"
  echo "⚠ 将返回的 database_id 填入 packages/api/wrangler.toml 的顶层 [[d1_databases]]"
  echo ""

  echo "--- 创建生产 R2 存储桶 ---"
  echo "执行: ${WRANGLER_CMD} r2 bucket create meigallery-media"
  echo ""

  echo "--- 创建生产广告平台 Events API Queue ---"
  create_queue "meigallery-ad-meta"
  create_queue "meigallery-ad-meta-dlq"
  create_queue "meigallery-ad-tiktok"
  create_queue "meigallery-ad-tiktok-dlq"
  create_queue "meigallery-ad-google"
  create_queue "meigallery-ad-google-dlq"
  echo ""

  echo "--- 创建生产业务 Queue 与诊断 DLQ ---"
  create_application_queues ""
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

  echo "--- 创建 dev 隔离业务 Queue 与诊断 DLQ ---"
  create_application_queues "-dev"
  echo ""

  echo "dev 不创建或绑定广告平台资源；业务 Queue 使用 -dev 后缀与 production 隔离。"
  echo ""
}

print_secrets() {
  local env_name=$1
  local env_flag='--env ""'

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
  echo "  # 数据注销 identity seal 当前 HMAC 主密钥；能力开启前必须配置"
  echo "  openssl rand -base64 32 | ${WRANGLER_CMD} secret put DATA_RIGHTS_RETENTION_MASTER_KEY_CURRENT ${env_flag}"
  echo "  # 仅密钥轮换窗口配置，平时可不设置"
  echo "  ${WRANGLER_CMD} secret put DATA_RIGHTS_RETENTION_MASTER_KEY_PREVIOUS ${env_flag}"
  if [ "$env_name" = "production" ]; then
    echo "  # 生成 32 字节随机主密钥并通过标准输入写入，不在终端输出明文"
    echo "  openssl rand -base64 32 | ${WRANGLER_CMD} secret put AD_PLATFORM_CREDENTIAL_MASTER_KEY_CURRENT ${env_flag}"
    echo "  # 仅通用凭证主密钥轮换窗口配置"
    echo "  ${WRANGLER_CMD} secret put AD_PLATFORM_CREDENTIAL_MASTER_KEY_PREVIOUS ${env_flag}"
  fi
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
