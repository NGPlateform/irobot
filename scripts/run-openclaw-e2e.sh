#!/usr/bin/env bash
# 一键复现：真 OpenClaw 网关 → 模型(本地 mock) → propose_action 插件 → robot-sim
# (外部 Command Orchestrator) → 仿真机器人移动。
#
# 前置：Node >=24.15（脚本会尝试 nvm use 24）；OpenClaw 源码已装依赖并可运行
#       （见 docs/spikes/openclaw-integration.md 的环境处置）。默认 OpenClaw 在 ./openclaw，
#       可用 OPENCLAW_DIR 覆盖。用法：scripts/run-openclaw-e2e.sh ["前进两米"]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_DIR="${OPENCLAW_DIR:-$ROOT/openclaw}"
MOCK_PORT="${MOCK_PORT:-8810}"
SIM_PORT="${SIM_PORT:-8899}"
MODEL="${IROBOT_OC_MODEL:-openai/gpt-5.6-sol}"
MESSAGE="${1:-前进两米}"
PLUGIN_DIR="$ROOT/platform/services/gateway-adapter/dist"
STATE_DIR="$(mktemp -d)"

if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 24 >/dev/null 2>&1 || true; fi

fail() { echo "✗ $1" >&2; exit 1; }
command -v node >/dev/null || fail "找不到 node"
node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' || fail "需要 Node >=24（当前 $(node -v)）；nvm install 24"
[ -f "$OPENCLAW_DIR/scripts/run-node.mjs" ] || fail "未找到 OpenClaw：$OPENCLAW_DIR（设 OPENCLAW_DIR）。见 docs/spikes/openclaw-integration.md"
[ -d "$OPENCLAW_DIR/node_modules" ] || fail "OpenClaw 依赖未安装。见 docs/spikes/openclaw-integration.md"

cleanup() { fuser -k "$MOCK_PORT/tcp" "$SIM_PORT/tcp" >/dev/null 2>&1 || true; rm -rf "$STATE_DIR"; }
trap cleanup EXIT
fuser -k "$MOCK_PORT/tcp" "$SIM_PORT/tcp" >/dev/null 2>&1 || true; sleep 1

echo "▸ 1/6 构建插件 bundle (esbuild)…"
( cd "$ROOT" && pnpm --filter @irobot/gateway-adapter build:plugin >/dev/null ) || fail "插件打包失败"

echo "▸ 2/6 启动 mock 模型 (:$MOCK_PORT)…"
node "$ROOT/scripts/mock-openai-responses.mjs" --port "$MOCK_PORT" >"$STATE_DIR/mock.log" 2>&1 &
echo "▸ 3/6 启动 robot-sim 外部 Orchestrator (:$SIM_PORT)…"
( cd "$ROOT" && IROBOT_AGENT=rules PORT="$SIM_PORT" pnpm --filter @irobot/robot-sim dev >"$STATE_DIR/sim.log" 2>&1 ) &
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$SIM_PORT/" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$SIM_PORT/" >/dev/null 2>&1 || fail "robot-sim 未就绪（见 $STATE_DIR/sim.log）"

# 必须在 OpenClaw 仓库根内运行 run-node.mjs（它按 cwd 定位源码/dist）。
run_oc() { ( cd "$OPENCLAW_DIR" && OPENCLAW_STATE_DIR="$STATE_DIR" OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 node scripts/run-node.mjs "$@" ); }

echo "▸ 4/6 link 安装插件到隔离网关…"
run_oc plugins install "$PLUGIN_DIR" --link --force >"$STATE_DIR/install.log" 2>&1 || true

echo "▸ 5/6 启用插件 + 配置 orchestratorUrl + 放行工具（隔离状态，不动 ~/.openclaw）…"
cat > "$STATE_DIR/openclaw.json" <<JSON
{ "agents": {}, "tools": { "allow": ["propose_action"] },
  "plugins": { "load": { "paths": ["$PLUGIN_DIR"] },
    "entries": { "irobot-gateway-adapter": { "enabled": true, "config": { "orchestratorUrl": "http://127.0.0.1:$SIM_PORT" } } } },
  "meta": { "migrations": { "modelPolicyAllowlist": true }, "lastTouchedVersion": "2026.7.2" } }
JSON

pose_x() { curl -s -N --max-time 2 "http://127.0.0.1:$SIM_PORT/events" 2>/dev/null | grep -m1 -oE '"pose":\{"x":[0-9.]+' | grep -oE '[0-9.]+$'; }
BEFORE="$(pose_x)"; BEFORE="${BEFORE:-0}"

echo "▸ 6/6 经真网关跑 agent turn：「$MESSAGE」"
echo "─── OpenClaw 可见输出 ───"
OPENAI_BASE_URL="http://127.0.0.1:$MOCK_PORT/v1" OPENAI_API_KEY="sk-mock-irobot" \
  run_oc agent --local --session-key e2e -m "$MESSAGE" --model "$MODEL" 2>"$STATE_DIR/agent.log"
echo "────────────────────────"

sleep 1
AFTER="$(pose_x)"; AFTER="${AFTER:-0}"
echo "机器人 pose.x: $BEFORE → $AFTER"

if awk "BEGIN{exit !($AFTER > $BEFORE + 0.5)}"; then
  echo "✅ PASS：语音/文本经真 OpenClaw 网关 + propose_action 插件驱动仿真机器人移动。"
else
  echo "✗ FAIL：机器人未移动。agent 日志尾部："; tail -20 "$STATE_DIR/agent.log"; exit 1
fi
