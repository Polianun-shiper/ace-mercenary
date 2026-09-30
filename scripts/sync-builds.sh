#!/usr/bin/env bash
# === 一键同步构建 (per user request: 改完代码自动同步 html,别等用户提醒) ===
# 每次改完代码后运行:  ./scripts/sync-builds.sh
#   1. tsc 类型检查(过滤已知错误)
#   2. dev 构建 → dist-test/index.html (8898 测试)
#   3. 正式单文件构建 → dist-single/index.html (双击即玩)
#   4. 重启 8898 测试服务器
# 失败时退出非零,不会静默产出旧包。
set -e
cd "$(dirname "$0")/.."

echo "[1/4] tsc --noEmit …"
npx tsc --noEmit 2>&1 | grep -v "socket.io\|radio\|gen_radio\|print_radio" || true

echo "[2/4] dev 构建 (dist-test) …"
node scripts/build-single-html.mjs --dev

echo "[3/4] 正式单文件构建 (dist-single) …"
node scripts/build-single-html.mjs

echo "[4/4] 重启测试服务器 …"
pkill -f serve-test.mjs 2>/dev/null || true
sleep 1
(nohup node scripts/serve-test.mjs > /tmp/serve-test.log 2>&1 &)
sleep 2
curl -s -o /dev/null -w "dev 8898: %{http_code}\n" http://127.0.0.1:8898/ || true

echo "=== 完成: dist-test/index.html + dist-single/index.html 已同步 ==="
