#!/bin/bash
# 多轮对话测试脚本
#
# 用法:
#   1. 启动服务: node --import tsx src/index.ts --config examples/multi-turn
#   2. 设置环境变量后运行: bash examples/multi-turn/test.sh
#
# 演示:
#   - 第一轮：不传 sessionId，服务端创建新会话，响应中返回 sessionId
#   - 第二轮：传入 sessionId，Agent 通过 resume 恢复上下文
#   - 第三轮：继续用同一 sessionId，验证上下文连续性

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
AGENT="${AGENT:-chatbot}"

echo "=== 第一轮：新会话（不传 sessionId）==="
RESP1=$(curl -s -X POST "$BASE_URL/v1/agents/$AGENT/runs" \
  -H "Content-Type: application/json" \
  -d '{"message":"我叫小明，请记住我的名字","stream":false}')
echo "$RESP1" | jq .
SESSION_ID=$(echo "$RESP1" | jq -r '.sessionId')
echo ">>> 获得 sessionId: $SESSION_ID"
echo ""

echo "=== 第二轮：用 sessionId resume ==="
RESP2=$(curl -s -X POST "$BASE_URL/v1/agents/$AGENT/runs" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"我叫什么名字？\",\"stream\":false,\"sessionId\":\"$SESSION_ID\"}")
echo "$RESP2" | jq .
echo ""

echo "=== 第三轮：继续同一会话 ==="
RESP3=$(curl -s -X POST "$BASE_URL/v1/agents/$AGENT/runs" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"我们之前聊了什么？\",\"stream\":false,\"sessionId\":\"$SESSION_ID\"}")
echo "$RESP3" | jq .
echo ""

SESSION_ID_2=$(echo "$RESP2" | jq -r '.sessionId')
SESSION_ID_3=$(echo "$RESP3" | jq -r '.sessionId')

echo "=== 验证 ==="
echo "第一轮 sessionId: $SESSION_ID"
echo "第二轮 sessionId: $SESSION_ID_2"
echo "第三轮 sessionId: $SESSION_ID_3"

if [ "$SESSION_ID" = "$SESSION_ID_2" ] && [ "$SESSION_ID" = "$SESSION_ID_3" ]; then
  echo ""
  echo "✅ 三轮对话 sessionId 一致: $SESSION_ID"
  echo "✅ 多轮对话 resume 工作正常"
else
  echo ""
  echo "❌ sessionId 不一致: $SESSION_ID / $SESSION_ID_2 / $SESSION_ID_3"
  exit 1
fi
