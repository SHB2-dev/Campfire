#!/usr/bin/env bash
# バックエンド起動スクリプト(Pterodactyl の egg から呼ばれる)
#  - AUTO_UPDATE=1 なら git pull
#  - CF_TUNNEL_TOKEN があれば Cloudflare Tunnel (cloudflared) を同時に起動
#  - バックエンドを起動
set -u
cd "$(dirname "$0")/.."

if [ "${AUTO_UPDATE:-0}" = "1" ] && [ -d .git ]; then
  git pull || echo "[start] git pull に失敗しました(そのまま続行します)"
fi

TUNNEL_PID=""
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  mkdir -p bin
  if [ ! -x bin/cloudflared ]; then
    case "$(uname -m)" in
      x86_64|amd64)  ARCH=amd64 ;;
      aarch64|arm64) ARCH=arm64 ;;
      *) echo "[start] 未対応のCPUです: $(uname -m)"; ARCH="" ;;
    esac
    if [ -n "$ARCH" ]; then
      echo "[start] cloudflared を取得中 (linux-$ARCH)"
      curl -fsSL -o bin/cloudflared.tmp "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" \
        && chmod +x bin/cloudflared.tmp && mv bin/cloudflared.tmp bin/cloudflared \
        || echo "[start] cloudflared の取得に失敗しました"
    fi
  fi
  if [ -x bin/cloudflared ]; then
    echo "[start] Cloudflare Tunnel を起動します"
    ./bin/cloudflared tunnel --no-autoupdate run --token "$CF_TUNNEL_TOKEN" > >(sed -u 's/^/[cloudflared] /') 2>&1 &
    TUNNEL_PID=$!
    trap '[ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null' EXIT INT TERM
  fi
else
  echo "[start] CF_TUNNEL_TOKEN が未設定のため、トンネルなしで起動します"
fi

cd backend
npm install --omit=dev --no-audit --no-fund
node src/index.js
