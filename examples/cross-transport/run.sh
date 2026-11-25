#!/usr/bin/env bash
set -euo pipefail
umask 077
server=$(realpath "${1:?pass the Server binary}")
accounts=$(realpath "${2:?pass the accounts binary}")
here=$(cd "$(dirname "$0")" && pwd)
sdk=$(cd "$here/../.." && pwd)
repo=$(cd "$sdk/../privchat-server" && pwd)
base=${PRIVCHAT_FEATURE_BASE_PORT:-59680}
[[ "$base" =~ ^[0-9]+$ ]] && ((base >= 30000 && base <= 60000))
root=$(mktemp -d "${TMPDIR:-/tmp}/privchat-cross-transport.XXXXXX")
session=$(basename "$root")
fixture= bridge_pid= static_pid=
pw() { npx --yes --package @playwright/cli playwright-cli "-s=$session" "$@"; }
cleanup() {
  local status=$? pid
  trap - EXIT
  pw close > /dev/null 2>&1 || true
  for pid in "$bridge_pid" "$static_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  if [[ -z "$fixture" ]]; then
    for candidate in "$root"/stack/privchat-features-im.*; do
      if [[ -d "$candidate" ]]; then fixture=$candidate; break; fi
    done
  fi
  if [[ -n "$fixture" && -d "$fixture" ]]; then
    if [[ -f "$fixture/launcher.pid" ]]; then
      pid=$(cat "$fixture/launcher.pid")
      if ps -p "$pid" -o args= | grep -Fq "$fixture/server-bin"; then kill "$pid" || true; fi
    fi
    if [[ -f "$fixture/redis.pid" ]]; then redis-cli -p "$((base+5))" shutdown nosave || true; fi
    if [[ -f "$fixture/db-name" ]]; then
      local db
      db=$(cat "$fixture/db-name")
      if [[ "$db" =~ ^privchat_features_[a-z0-9_]+$ ]]; then
        dropdb --if-exists --force "$db" || status=1
      fi
    fi
  fi
  if [[ "${PRINT_FIXTURE_LOGS:-0}" == 1 || "$status" != 0 ]]; then
    for log in accounts.log bridge.log browser-cli.log; do
      if [[ -f "$root/$log" ]]; then tail -20 "$root/$log" >&2; fi
    done
    if [[ -s "$root/state/browser-error" ]]; then cat "$root/state/browser-error" >&2; fi
  fi
  find "$root" -depth -delete
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$root"
mkdir state
"$sdk/node_modules/.bin/esbuild" "$here/browser.ts" --bundle --ignore-annotations --platform=browser --target=es2022 --outfile="$root/browser.js"
fixture=$(PRIVCHAT_FEATURE_PARENT="$root/stack" PRIVCHAT_FEATURE_BASE_PORT="$base" \
  PRIVCHAT_FEATURE_DOWNLOAD_PORT="$((base+6))" PRIVCHAT_FEATURE_BINARY="$server" \
  PRIVCHAT_ATTACHMENT_KEYS="1:$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
  bash "$repo/scripts/acceptance/start-feature-fixture.sh")
PYTHONDONTWRITEBYTECODE=1 python3 -c '
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("files", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.HOST, module.PORT, module.STATIC_DIR = "127.0.0.1", int(sys.argv[2]), Path(sys.argv[3])
module.main()
' "$repo/file_local_server.py" "$((base+6))" "$fixture/storage" >static.log 2>&1 &
static_pid=$!
node "$here/bridge.mjs" "$root/state" "$root/browser.js" "$base" >bridge.log 2>&1 &
bridge_pid=$!
for i in $(seq 1 12); do
  if [[ -s bridge.log ]]; then break; fi
  kill -0 "$bridge_pid"
  sleep 1
done
port=$(cat bridge.log)
[[ "$port" =~ ^[0-9]+$ ]]
pw open "http://127.0.0.1:$port/" >browser-cli.log 2>&1
env -u PRIVCHAT_TEST_TRANSPORT -u PRIVCHAT_DEAD_RECOVERY_DIR -u PRIVCHAT_RESTART_FAULT_DIR -u PRIVCHAT_RESTART_FAULT_MODE \
  PRIVCHAT_HOST=127.0.0.1 PRIVCHAT_CROSS_TRANSPORT_DIR="$root/state" PRIVCHAT_QUIC_PORT="$((base+2))" \
  PRIVCHAT_TCP_PORT="$((base+1))" PRIVCHAT_SPKI_PINS="$(cat "$fixture/spki-pins.txt")" TMPDIR="$root" \
  "$accounts" >accounts.log 2>&1
grep -F '[PASS]' accounts.log
