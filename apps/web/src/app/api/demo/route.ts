import { NextResponse } from "next/server";
import {
  type Address,
  type Hex,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { monadTestnet, publicClient, transport } from "@/lib/chain";
import { encumberAbi } from "@/lib/encumber-abi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 每一轮演示的预算规模：团队 0.1 MON，甲 0.06、乙 0.04 */
const ROUND = parseEther(process.env.DEMO_ROUND || "0.1");
const ALLOC_A = (ROUND * 6n) / 10n;
const ALLOC_B = ROUND - ALLOC_A;
const LEFT_A = ALLOC_A / 3n; // 开场后甲只剩 1/3（0.02）
const ACTUAL = (LEFT_A * 6n) / 10n; // 实际花费 0.012，释放 0.008

const Body = z.object({
  step: z.enum([
    "reset",
    "setup",
    "reserve",
    "finance-cancel",
    "reallocate",
    "settle",
    "realloc-released",
    "race",
  ]),
  first: z.enum(["pay", "reallocate"]).optional(),
});

function key(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return (v.startsWith("0x") ? v : `0x${v}`) as Hex;
}

function clients() {
  const address = process.env.NEXT_PUBLIC_ENCUMBER_ADDRESS as Address | undefined;
  if (!address) throw new Error("NEXT_PUBLIC_ENCUMBER_ADDRESS is not set");
  const mk = (k: Hex) =>
    createWalletClient({ account: privateKeyToAccount(k), chain: monadTestnet, transport });
  return {
    address,
    owner: mk(key("FUNDER_PRIVATE_KEY")),
    agentA: mk(key("AGENT_A_KEY")),
    agentB: mk(key("AGENT_B_KEY")),
    vendorA: mk(key("VENDOR_A_KEY")),
  };
}

type Step = {
  label: string;
  hash: Hex;
  block: string;
  index: number;
  ok: boolean;
  reason?: string;
};

const REASONS = [
  "",
  "调用者不是 Agent",
  "可用余额不足",
  "这笔钱已被预占",
  "不是这笔承诺指定的供应商",
  "承诺已结算或释放",
  "实际花费超过锁定上限",
  "项目不存在",
  "承诺还没到期，谁也取消不了",
  "承诺已过期",
];

async function exec(
  wallet: ReturnType<typeof clients>["owner"],
  address: Address,
  label: string,
  functionName: string,
  args: readonly unknown[] = [],
  value?: bigint,
): Promise<Step> {
  // 动态函数名，参数由调用方保证
  const receipt = await wallet.writeContractSync({
    address,
    abi: encumberAbi,
    functionName,
    args,
    value,
    account: wallet.account!,
    chain: monadTestnet,
  } as never);
  return summarize(label, receipt);
}

function summarize(
  label: string,
  receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>,
): Step {
  let rejectedReason: string | undefined;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: encumberAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "Rejected") rejectedReason = REASONS[Number(ev.args.reason)] ?? "被拦截";
    } catch {
      /* 不是本合约的事件 */
    }
  }
  return {
    label,
    hash: receipt.transactionHash,
    block: receipt.blockNumber.toString(),
    index: receipt.transactionIndex,
    ok: receipt.status === "success" && !rejectedReason,
    reason: receipt.status !== "success" ? "交易失败" : rejectedReason,
  };
}

async function currentRound(address: Address) {
  const count = await publicClient.readContract({
    address,
    abi: encumberAbi,
    functionName: "projectCount",
  });
  if (count < 2n) throw new Error("还没有项目，请先重置");
  return { a: count - 2n, b: count - 1n };
}

export async function POST(request: Request) {
  // 演示口令：只有带口令打开的控制台能发交易，其他人只读
  const demoKey = process.env.DEMO_KEY;
  if (demoKey && request.headers.get("x-demo-key") !== demoKey) {
    return NextResponse.json({ error: "只读模式：需要演示口令" }, { status: 401 });
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数不正确" }, { status: 400 });
  const { step, first } = parsed.data;

  try {
    const c = clients();
    const { address, owner, agentA, agentB, vendorA: vendorAWallet } = c;
    const steps: Step[] = [];
    const vendorA = (process.env.VENDOR_A_ADDRESS || owner.account!.address) as Address;
    const vendorB = (process.env.VENDOR_B_ADDRESS || owner.account!.address) as Address;

    if (step === "reset") {
      // 新开一轮：建两个新项目，Agent 改绑到新项目，存入并分配预算
      const count = await publicClient.readContract({
        address,
        abi: encumberAbi,
        functionName: "projectCount",
      });
      const a = count;
      const b = count + 1n;
      steps.push(await exec(owner, address, "存入团队预算", "deposit", [], ROUND));
      steps.push(
        await exec(owner, address, "创建 客服项目（甲）", "createProject", ["客服项目", vendorA]),
      );
      steps.push(
        await exec(owner, address, "创建 数据项目（乙）", "createProject", ["数据项目", vendorB]),
      );
      steps.push(
        await exec(owner, address, "绑定 客服 Agent → 甲", "addAgent", [
          agentA.account!.address,
          a,
          "客服 Agent",
        ]),
      );
      steps.push(
        await exec(owner, address, "绑定 数据 Agent → 乙", "addAgent", [
          agentB.account!.address,
          b,
          "数据 Agent",
        ]),
      );
      steps.push(await exec(owner, address, "分配 甲", "allocate", [a, ALLOC_A]));
      steps.push(await exec(owner, address, "分配 乙", "allocate", [b, ALLOC_B]));
    } else if (step === "setup") {
      // 开场：乙花完，甲花到只剩 1/3
      steps.push(await exec(agentB, address, "数据 Agent 付款（乙花完）", "pay", [ALLOC_B]));
      steps.push(
        await exec(agentA, address, "客服 Agent 付款（甲只剩 1/3）", "pay", [ALLOC_A - LEFT_A]),
      );
    } else if (step === "reserve") {
      steps.push(
        await exec(
          agentA,
          address,
          "客服 Agent 锁款 0.02（绑定供应商、订单号、10 分钟截止）",
          "reserve",
          [LEFT_A, `0x${Buffer.from(`order-${Date.now()}`).toString("hex").padEnd(64, "0")}`, 600n],
        ),
      );
    } else if (step === "finance-cancel") {
      // Agent 已掉线：财务想取消这笔承诺、或把钱调走，都会被合约拒绝
      const { a, b } = await currentRound(address);
      const n = await publicClient.readContract({
        address,
        abi: encumberAbi,
        functionName: "reservationCount",
      });
      if (n === 0n) throw new Error("还没有锁款");
      steps.push(await exec(owner, address, "财务尝试取消这笔承诺", "release", [n - 1n]));
      steps.push(
        await exec(owner, address, "财务尝试把这 0.02 调给乙", "reallocate", [a, b, LEFT_A]),
      );
    } else if (step === "reallocate") {
      const { a, b } = await currentRound(address);
      steps.push(
        await exec(owner, address, "财务把这笔钱从甲调给乙", "reallocate", [a, b, LEFT_A]),
      );
    } else if (step === "settle") {
      const n = await publicClient.readContract({
        address,
        abi: encumberAbi,
        functionName: "reservationCount",
      });
      if (n === 0n) throw new Error("还没有预占");
      steps.push(
        await exec(
          vendorAWallet,
          address,
          "供应商自己按实际用量 0.012 结算（Agent 不在线也能收款）",
          "settle",
          [n - 1n, ACTUAL],
        ),
      );
    } else if (step === "realloc-released") {
      const { a, b } = await currentRound(address);
      steps.push(
        await exec(owner, address, "财务调拨释放出来的部分", "reallocate", [a, b, LEFT_A - ACTUAL]),
      );
    } else if (step === "race") {
      // 甲剩下的钱：Agent 付款 和 财务调拨 同时提交，看谁先上链
      const { a, b } = await currentRound(address);
      // 先把局面摆好：乙花完、甲正好剩 LEFT_A（这样两笔里只能成功一笔）
      const ps = await publicClient.readContract({
        address,
        abi: encumberAbi,
        functionName: "getProjects",
      });
      const pa = ps[Number(a)];
      const pb = ps[Number(b)];
      if (pa.reserved > 0n || pa.available < LEFT_A) {
        throw new Error("甲的可用余额不够或有未结算的预占，请先「新开一轮」");
      }
      if (pb.available > 0n) {
        steps.push(await exec(agentB, address, "准备：数据 Agent 花完乙", "pay", [pb.available]));
      }
      if (pa.available > LEFT_A) {
        steps.push(
          await exec(agentA, address, "准备：客服 Agent 把甲花到只剩 1/3", "pay", [
            pa.available - LEFT_A,
          ]),
        );
      }
      // Monad 新到账 / 新状态需要几个区块才稳定，稍等再发两笔竞争交易
      await new Promise((r) => setTimeout(r, 1500));
      const payTx = {
        wallet: agentA,
        label: "客服 Agent 付款",
        data: encodeFunctionData({ abi: encumberAbi, functionName: "pay", args: [LEFT_A] }),
      };
      const reallocTx = {
        wallet: owner,
        label: "财务调拨 甲→乙",
        data: encodeFunctionData({
          abi: encumberAbi,
          functionName: "reallocate",
          args: [a, b, LEFT_A],
        }),
      };
      const ordered = first === "reallocate" ? [reallocTx, payTx] : [payTx, reallocTx];
      // 先把两笔交易都签好，再紧接着发出去
      const signed = await Promise.all(
        ordered.map(async (t) => {
          const req = await t.wallet.prepareTransactionRequest({
            account: t.wallet.account!,
            chain: monadTestnet,
            to: address,
            data: t.data,
            gas: 200_000n,
          });
          return { label: t.label, raw: await t.wallet.signTransaction(req as never) };
        }),
      );
      const hashes: Hex[] = [];
      for (const s of signed)
        hashes.push(await publicClient.sendRawTransaction({ serializedTransaction: s.raw }));
      const receipts = await Promise.all(
        hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })),
      );
      receipts.forEach((r, i) => steps.push(summarize(signed[i].label, r)));
    }

    return NextResponse.json({ steps });
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
