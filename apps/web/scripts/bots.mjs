// 机器人观众：现场人少或网络差时补位，几个钱包轮流抢屏，保证大屏有动静
// 用法：bun run bots [机器人数量=5] [运行秒数=300]
// 读取 apps/web/.env.local：FUNDER_PRIVATE_KEY（给机器人发币）、NEXT_PUBLIC_CONTRACT_ADDRESS、NEXT_PUBLIC_RPC_URL
// 机器人私钥保存在 apps/web/.bots.json（已被 gitignore），下次复用
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const webDir = new URL("..", import.meta.url);
const envPath = new URL(".env.local", webDir);
const devEnvPath = new URL(".env.development.local", webDir);
const botsPath = new URL(".bots.json", webDir);

function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

const env = {
  ...loadEnv(envPath),
  ...(process.env.BOTS_USE_DEV ? loadEnv(devEnvPath) : {}),
  ...process.env,
};
const CONTRACT = env.NEXT_PUBLIC_CONTRACT_ADDRESS;
const RPC = env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";
const FUNDER = env.FUNDER_PRIVATE_KEY;
const COUNT = Number(process.argv[2] || 5);
const DURATION_S = Number(process.argv[3] || 300);

if (!CONTRACT || !FUNDER) {
  console.error(
    "请先在 apps/web/.env.local 填写 NEXT_PUBLIC_CONTRACT_ADDRESS 和 FUNDER_PRIVATE_KEY",
  );
  process.exit(1);
}

const abi = [
  {
    type: "function",
    name: "takeOver",
    stateMutability: "payable",
    inputs: [
      { name: "slotId", type: "uint256" },
      { name: "nickname", type: "string" },
      { name: "kind", type: "uint8" },
      { name: "content", type: "string" },
      { name: "newPrice", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fundPlayers",
    stateMutability: "payable",
    inputs: [
      { name: "players", type: "address[]" },
      { name: "amountEach", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSlots",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "holder", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "price", type: "uint256" },
          { name: "depositLeft", type: "uint256" },
          { name: "secondsLeft", type: "uint256" },
          { name: "lastSettled", type: "uint256" },
          { name: "nickname", type: "string" },
          { name: "content", type: "string" },
        ],
      },
    ],
  },
];

const NAMES = ["阿强", "小美", "老王", "Monad 粉", "链上土豪", "广州靓仔", "并行 EVM", "300ms"];
const LINES = [
  "这块屏，我包了 😎",
  "广州最靓的仔在此",
  "Monad 300ms 出块，谁比我快？",
  "老板看到请加薪",
  "定价低是我故意的",
  "被抢了也不亏，钱退给我",
  "LFG 🚀",
  "今晚的 MVP 是我",
  "有本事你来抢",
  "Harberger 税真香",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = http(RPC, { timeout: 10_000, retryCount: 2 });
const pub = createPublicClient({ chain: monadTestnet, transport });

let keys = existsSync(botsPath) ? JSON.parse(readFileSync(botsPath, "utf8")) : [];
while (keys.length < COUNT) keys.push(generatePrivateKey());
writeFileSync(botsPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
const bots = keys.slice(0, COUNT).map((k, i) => {
  const account = privateKeyToAccount(k);
  return {
    name: NAMES[i % NAMES.length],
    account,
    wallet: createWalletClient({ account, chain: monadTestnet, transport }),
  };
});

// 余额不足的机器人，由主持人钱包一次性批量发币
const FUND = parseEther("0.3");
const balances = await Promise.all(bots.map((b) => pub.getBalance({ address: b.account.address })));
const needy = bots.filter((_, i) => balances[i] < FUND / 2n).map((b) => b.account.address);
if (needy.length) {
  const funder = createWalletClient({
    account: privateKeyToAccount(FUNDER),
    chain: monadTestnet,
    transport,
  });
  const hash = await funder.writeContract({
    address: CONTRACT,
    abi,
    functionName: "fundPlayers",
    args: [needy, FUND],
    value: FUND * BigInt(needy.length),
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`给 ${needy.length} 个机器人各发了 ${formatEther(FUND)} MON`);
  await sleep(1500); // 新到账的钱约 3 个区块后才能用
}

const end = Date.now() + DURATION_S * 1000;
let grabs = 0;

async function runBot(bot) {
  await sleep(Math.random() * 4000);
  while (Date.now() < end) {
    try {
      const slots = await pub.readContract({ address: CONTRACT, abi, functionName: "getSlots" });
      const slotId = Math.floor(Math.random() * slots.length);
      const s = slots[slotId];
      if (s.holder.toLowerCase() !== bot.account.address.toLowerCase()) {
        const cost = s.holder === "0x0000000000000000000000000000000000000000" ? 0n : s.price;
        const price = parseEther((0.002 + Math.random() * 0.03).toFixed(4));
        const deposit = ((price * 100n) / 10_000n) * BigInt(20 + Math.floor(Math.random() * 40));
        const balance = await pub.getBalance({ address: bot.account.address });
        if (balance > cost + deposit + parseEther("0.02")) {
          const started = Date.now();
          const receipt = await bot.wallet.writeContractSync({
            address: CONTRACT,
            abi,
            functionName: "takeOver",
            args: [BigInt(slotId), bot.name, 0, pick(LINES), price],
            value: cost + deposit,
          });
          grabs += 1;
          console.log(
            `${bot.name} 抢下 ${["主位", "小格 1", "小格 2"][slotId]}，定价 ${formatEther(price)} MON，` +
              `${receipt.status === "success" ? "成功" : "失败"}，确认 ${Date.now() - started}ms`,
          );
        }
      }
    } catch (e) {
      console.warn(
        `${bot.name} 这次没抢成：${(e.shortMessage || e.message || String(e)).split("\n")[0]}`,
      );
    }
    await sleep(4000 + Math.random() * 6000); // 每个机器人 4~10 秒抢一次，也满足低余额账户的冷却
  }
}

console.log(`${bots.length} 个机器人开始抢屏，持续 ${DURATION_S} 秒（Ctrl+C 停止）`);
await Promise.all(bots.map(runBot));
console.log(`结束，共抢屏 ${grabs} 次`);
