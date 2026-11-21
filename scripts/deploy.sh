#!/usr/bin/env bash
# 一键部署 HoldTheScreen 到 Monad 测试网
# - 部署私钥读 apps/web/.env.local 里的 FUNDER_PRIVATE_KEY（发币接口要求部署者 = 发币者）
# - 场地方收款地址：第一次运行时生成一个新钱包，保存在 contracts/.env（已被 gitignore）
# - 部署成功后，把合约地址写回 apps/web/.env.local 的 NEXT_PUBLIC_CONTRACT_ADDRESS
# 用法：bash scripts/deploy.sh [rpc_url]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/apps/web/.env.local}"
CONTRACTS_ENV="${CONTRACTS_ENV:-$ROOT/contracts/.env}"
RPC_URL="${1:-https://testnet-rpc.monad.xyz}"
FORGE="${FORGE:-$(command -v forge || echo "$HOME/.foundry/bin/forge")}"
CAST="${CAST:-$(command -v cast || echo "$HOME/.foundry/bin/cast")}"
VENUE_SHARE_BPS="${VENUE_SHARE_BPS:-7000}"

read_env() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

PK="$(read_env FUNDER_PRIVATE_KEY "$ENV_FILE")"
if [ -z "$PK" ]; then
  echo "❌ 请先在 $ENV_FILE 里填写 FUNDER_PRIVATE_KEY" >&2
  exit 1
fi
case "$PK" in 0x*) ;; *) PK="0x$PK" ;; esac

DEPLOYER="$("$CAST" wallet address --private-key "$PK")"
echo "部署钱包：$DEPLOYER（余额 $("$CAST" balance "$DEPLOYER" --rpc-url "$RPC_URL" --ether) MON）"

VENUE="$(read_env VENUE_ADDRESS "$CONTRACTS_ENV")"
if [ -z "$VENUE" ]; then
  NEW="$("$CAST" wallet new --json)"
  read -r VENUE VENUE_PK < <(echo "$NEW" | python3 -c '
import sys, json
d = json.load(sys.stdin)
d = d.get("data", d)
d = d[0] if isinstance(d, list) else d
print(d["address"], d["private_key"])')
  umask 077
  printf "VENUE_ADDRESS=%s\nVENUE_PRIVATE_KEY=%s\n" "$VENUE" "$VENUE_PK" >> "$CONTRACTS_ENV"
  echo "已生成场地方收款地址：$VENUE（私钥保存在 contracts/.env）"
else
  echo "场地方收款地址：$VENUE"
fi

cd "$ROOT/contracts"
OUT="$("$FORGE" create src/HoldTheScreen.sol:HoldTheScreen \
  --rpc-url "$RPC_URL" --private-key "$PK" --broadcast \
  --constructor-args "$VENUE" "$VENUE_SHARE_BPS")"
ADDRESS="$(echo "$OUT" | awk '/Deployed to:/ {print $3}')"
TX="$(echo "$OUT" | awk '/Transaction hash:/ {print $3}')"
if [ -z "$ADDRESS" ]; then
  echo "$OUT" >&2
  echo "❌ 部署失败" >&2
  exit 1
fi

if grep -qE '^NEXT_PUBLIC_CONTRACT_ADDRESS=' "$ENV_FILE"; then
  sed -i.bak "s|^NEXT_PUBLIC_CONTRACT_ADDRESS=.*|NEXT_PUBLIC_CONTRACT_ADDRESS=$ADDRESS|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
else
  echo "NEXT_PUBLIC_CONTRACT_ADDRESS=$ADDRESS" >> "$ENV_FILE"
fi

echo "✅ 合约地址：$ADDRESS"
echo "   部署交易：$TX"
echo "   已写入 apps/web/.env.local"
