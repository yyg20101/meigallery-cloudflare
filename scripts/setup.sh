#!/usr/bin/env bash
set -euo pipefail

# MeiGallery 首次部署初始化
# 创建 D1 数据库、R2 桶、设置 secrets

echo "=== MeiGallery 初始化 ==="

echo ""
echo "--- 创建 D1 数据库 ---"
echo "执行: wrangler d1 create meigallery-db"
echo "创建后将返回的 database_id 填入 packages/api/wrangler.toml"
echo ""

echo "--- 创建 R2 存储桶 ---"
echo "执行: wrangler r2 bucket create meigallery-media"
echo ""

echo "--- 设置 Secrets（在 packages/api 目录下执行） ---"
echo "  wrangler secret put SESSION_SECRET"
echo "  wrangler secret put TURNSTILE_SECRET_KEY"
echo "  wrangler secret put STREAM_ACCOUNT_ID"
echo "  wrangler secret put STREAM_API_TOKEN"
echo ""

echo "--- 初始化种子数据 ---"
echo "D1 migrations 会自动创建 membership_levels 表数据"
echo "还需手动创建 Owner 账户（通过 API /api/auth/register 后修改角色）"
echo ""

echo "完成后执行 ./scripts/deploy.sh 进行部署"
