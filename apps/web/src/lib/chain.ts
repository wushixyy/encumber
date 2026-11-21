import { type Address, createPublicClient, fallback, formatEther, http } from "viem";
import { monadTestnet } from "viem/chains";

export { monadTestnet };

const RPC_URLS = [
  process.env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz",
  "https://rpc.testnet.monad.xyz",
];

/** 公共 RPC 并发时可能断连：加超时、重试，并在主节点失败时切到备用节点 */
export const transport = fallback(
  RPC_URLS.map((url) => http(url, { timeout: 10_000, retryCount: 2, retryDelay: 300 })),
);

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport,
  pollingInterval: 500,
});

export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || undefined) as
  | Address
  | undefined;

const EXPLORER_URL = "https://testnet.monadexplorer.com";

export const txUrl = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;

/** 把 wei 格式化成最多 4 位小数的 MON */
export function formatMon(wei: bigint, digits = 4): string {
  const [whole, frac = ""] = formatEther(wei).split(".");
  const trimmed = frac.slice(0, digits).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
