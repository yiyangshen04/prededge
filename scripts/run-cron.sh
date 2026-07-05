#!/usr/bin/env bash
# Cron wrapper:加载 env → 解析 WSL 宿主代理 → 跑脚本 → 成功后打标记 + healthchecks 心跳。
#
# 用法: run-cron.sh scripts/<name>.ts [args...]
# 部署位置: $HOME/prededge/run-cron.sh(crontab 直接引用;仓库源在 scripts/run-cron.sh)
#
# 成功(exit 0)时:
#   - touch data/last-ok-<name>            —— heartbeat.ts 靠它的 mtime 判活
#   - curl $HC_PING_<NAME>(如已配置)     —— healthchecks.io 死人开关
# 失败时不 ping:ping 的语义是"工作正常",不是"cron 在跑"。
set -a
source "$HOME/prededge/.env"
set +a

# RPC 与 hc-ping.com 一律直连(实测 drpc 走 Clash 会 TLS 失败;心跳走代理会在
# Clash 挂掉时产生"扫描器死了"的误报)。域名从 ONCHAIN_RPC_URLS 动态提取。
RPC_HOSTS=$(echo "${ONCHAIN_RPC_URLS:-}" | tr ',' '\n' | sed -E 's#https?://([^/]+).*#\1#' | paste -sd, -)
NO_PROXY_LIST="localhost,127.0.0.1,hc-ping.com,polygon-bor-rpc.publicnode.com,1rpc.io${RPC_HOSTS:+,$RPC_HOSTS}"

# WSL2: Clash Verge 监听在 Windows 宿主机 = 默认网关,IP 随 WSL 重启变化,运行时解析。
if [ -n "$PROXY_PORT" ]; then
  WSL_HOST=$(ip route show default | awk '{print $3}' | head -1)
  if [ -n "$WSL_HOST" ]; then
    export HTTPS_PROXY="http://$WSL_HOST:$PROXY_PORT"
    export HTTP_PROXY="http://$WSL_HOST:$PROXY_PORT"
    export NO_PROXY="$NO_PROXY_LIST"
    # curl 只认小写 http_proxy;no_proxy 两种大小写都补齐
    export https_proxy="$HTTPS_PROXY" http_proxy="$HTTP_PROXY" no_proxy="$NO_PROXY"
  fi
fi
# Node fetch 只在此开关下才读 HTTP(S)_PROXY(Node >= 24)
export NODE_USE_ENV_PROXY=1
export PATH="$HOME/opt/node/bin:$PATH"
cd "$HOME/prededge" || exit 1

npx tsx "$@"
rc=$?

name=$(basename "$1" .ts)
if [ "$rc" -eq 0 ]; then
  mkdir -p data
  touch "data/last-ok-$name"

  ping_url=""
  case "$name" in
    chain-watch) ping_url="${HC_PING_CHAIN_WATCH:-}" ;;
    scan-notify) ping_url="${HC_PING_SCAN_NOTIFY:-}" ;;
  esac
  if [ -n "$ping_url" ]; then
    # 直连优先(hc-ping.com 在 NO_PROXY 里);失败再显式走一次代理兜底
    curl -fsS -m 10 --retry 2 "$ping_url" >/dev/null 2>&1 \
      || { [ -n "${HTTPS_PROXY:-}" ] && curl -fsS -m 10 -x "$HTTPS_PROXY" "$ping_url" >/dev/null 2>&1; } \
      || echo "[run-cron] healthchecks ping failed for $name ($(date '+%F %T'))"
  fi
fi

exit "$rc"
