#!/usr/bin/env bash
# バックエンド起動スクリプト(Pterodactyl の egg から呼ばれる)
#  - AUTO_UPDATE=1 なら最新版に更新(履歴は取得せず差分だけ)
#  - CF_TUNNEL_TOKEN があれば Cloudflare Tunnel (cloudflared) を同時に起動
#  - 依存パッケージは package.json / package-lock.json が変わったときだけインストール
#  - バックエンドを起動
set -u
cd "$(dirname "$0")/.."

# --- download_with_percent ---
# URL をダウンロードして、10%ごとに「何を・何%」を表示する。使い方: download_with_percent URL 保存先 表示名
download_with_percent() {
  local url="$1" dest="$2" label="$3" total last=-1 size step rc pid
  total=$(curl -fsSIL "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{print n+0}')
  rm -f "$dest"
  curl -fsSL -o "$dest" "$url" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "${total:-0}" -gt 0 ] && [ -f "$dest" ]; then
      size=$(stat -c %s "$dest" 2>/dev/null || echo 0)
      step=$(( size * 100 / total / 10 * 10 ))
      if [ "$step" -gt "$last" ] && [ "$step" -lt 100 ]; then echo "[start] ${label} ${step}%"; last=$step; fi
    fi
    sleep 1
  done
  wait "$pid"; rc=$?
  if [ "$rc" -eq 0 ]; then echo "[start] ${label} 100%"; fi
  return "$rc"
}

# git の進捗(Receiving objects / Resolving deltas)を 50% と 100% だけ表示する。使い方: git_with_percent git fetch ...
git_with_percent() {
  local log rc
  log=$(mktemp)
  "$@" >"$log" 2>&1; rc=$?
  tr '\r' '\n' <"$log" | grep -E '(Receiving objects|Resolving deltas): +(50|100)%' | grep -v ', done' | sed 's/^/[git] /'
  if [ "$rc" -ne 0 ]; then cat "$log"; fi
  rm -f "$log"
  return "$rc"
}
# --- /download_with_percent ---

if [ "${AUTO_UPDATE:-0}" = "1" ] && [ -d .git ]; then
  echo "[start] 最新版を確認中"
  git_with_percent git fetch --progress --depth 1 origin "${GIT_BRANCH:-main}" && git reset -q --hard FETCH_HEAD \
    || echo "[start] 更新に失敗しました(そのまま続行します)"
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
      echo "[start] cloudflared を取得します (linux-$ARCH、初回のみ)"
      download_with_percent "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" bin/cloudflared.tmp "cloudflared をダウンロード中" \
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
DEPS_HASH="$(cat package.json package-lock.json 2>/dev/null | sha1sum | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat .deps-hash 2>/dev/null)" != "$DEPS_HASH" ]; then
  echo "[start] 依存パッケージをインストール中(変更があったときのみ。数十秒かかります)"
  npm install --omit=dev --no-audit --no-fund --no-progress --loglevel=error && echo "$DEPS_HASH" > .deps-hash \
    && echo "[start] 依存パッケージのインストール完了"
fi
node src/index.js
