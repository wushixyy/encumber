import { NextResponse } from "next/server";
import { type Address, createWalletClient, getAddress, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { holdTheScreenAbi } from "@/lib/abi";
import { CONTRACT_ADDRESS, monadTestnet, publicClient, transport } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ address: z.string().refine((v) => isAddress(v), "invalid address") });

const FUND_AMOUNT = parseEther(process.env.FUND_AMOUNT || "0.1");
const FUND_BUDGET = parseEther(process.env.FUND_BUDGET || "10");
const BATCH_DELAY_MS = 800;

type Waiter = { address: Address; resolve: (hash: string) => void; reject: (e: unknown) => void };

// 进程内状态：同一个实例里攒批发币，并串行发送，避免 nonce 冲突
const queue: Waiter[] = [];
const funded = new Set<string>();
let spent = 0n;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sending: Promise<void> = Promise.resolve();

function getWallet() {
  const key = process.env.FUNDER_PRIVATE_KEY;
  if (!key) throw new Error("FUNDER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`);
  return createWalletClient({ account, chain: monadTestnet, transport });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = queue.splice(0, queue.length);
    if (batch.length === 0) return;
    sending = sending.then(() => sendBatch(batch));
  }, BATCH_DELAY_MS);
}

async function sendBatch(batch: Waiter[]) {
  try {
    const wallet = getWallet();
    const receipt = await wallet.writeContractSync({
      address: CONTRACT_ADDRESS!,
      abi: holdTheScreenAbi,
      functionName: "fundPlayers",
      args: [batch.map((w) => w.address), FUND_AMOUNT],
      value: FUND_AMOUNT * BigInt(batch.length),
    });
    if (receipt.status !== "success") throw new Error("fund transaction reverted");
    for (const w of batch) w.resolve(receipt.transactionHash);
  } catch (e) {
    for (const w of batch) {
      funded.delete(w.address.toLowerCase());
      spent -= FUND_AMOUNT;
      w.reject(e);
    }
  }
}

export async function POST(request: Request) {
  if (!CONTRACT_ADDRESS) {
    return NextResponse.json({ error: "合约地址未配置" }, { status: 500 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "钱包地址不正确" }, { status: 400 });
  }
  const address = getAddress(parsed.data.address);
  const key = address.toLowerCase();

  // 每个地址只发一次：本实例记过的，或者链上已经有余额的，都不再发
  if (funded.has(key)) return NextResponse.json({ status: "already" });
  const balance = await publicClient.getBalance({ address });
  if (balance >= FUND_AMOUNT / 2n) {
    funded.add(key);
    return NextResponse.json({ status: "already" });
  }
  if (spent + FUND_AMOUNT > FUND_BUDGET) {
    return NextResponse.json({ error: "今天的体验币发完了，请连接自己的钱包" }, { status: 429 });
  }

  funded.add(key);
  spent += FUND_AMOUNT;
  try {
    const hash = await new Promise<string>((resolve, reject) => {
      queue.push({ address, resolve, reject });
      scheduleFlush();
    });
    return NextResponse.json({ status: "funded", txHash: hash });
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return NextResponse.json({ error: `发币失败：${message}` }, { status: 502 });
  }
}
