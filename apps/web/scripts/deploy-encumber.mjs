// 部署 Encumber 并完成演示初始化：团队存入预算、建两个项目、绑定两个 Agent、分配预算、给 Agent 发 gas
// 用法：bun run deploy:encumber （先在 contracts/ 里 forge build）
// 读取 / 写回 apps/web/.env.local：FUNDER_PRIVATE_KEY（财务管理员 = 部署者），写入 NEXT_PUBLIC_ENCUMBER_ADDRESS、AGENT_A_KEY、AGENT_B_KEY
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const envPath = new URL("../.env.local", import.meta.url);
const artifactPath = new URL("../../../contracts/out/Encumber.sol/Encumber.json", import.meta.url);

const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const env = Object.fromEntries(
  envText
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
function setEnv(key, value) {
  let text = readFileSync(envPath, "utf8");
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(envPath, text, { mode: 0o600 });
}

const RPC = env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz";
const pk = env.FUNDER_PRIVATE_KEY;
if (!pk) throw new Error("apps/web/.env.local 里没有 FUNDER_PRIVATE_KEY");
const owner = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const transport = http(RPC, { timeout: 20_000, retryCount: 3 });
const pub = createPublicClient({ chain: monadTestnet, transport });
const wallet = createWalletClient({ account: owner, chain: monadTestnet, transport });

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const abi = artifact.abi;
const bytecode = artifact.bytecode.object;

const BUDGET = parseEther(process.env.BUDGET || "1");
const ALLOC_A = parseEther(process.env.ALLOC_A || "0.6");
const ALLOC_B = parseEther(process.env.ALLOC_B || "0.4");
const AGENT_GAS = parseEther(process.env.AGENT_GAS || "0.5");

console.log(
  `财务管理员：${owner.address}（余额 ${formatEther(await pub.getBalance({ address: owner.address }))} MON）`,
);

const deployHash = await wallet.deployContract({ abi, bytecode });
const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash });
const address = deployReceipt.contractAddress;
console.log(`✅ Encumber 合约：${address}（部署交易 ${deployHash}）`);

// Agent 钱包：没有就生成，保存在 .env.local
const agentAKey = env.AGENT_A_KEY || generatePrivateKey();
const agentBKey = env.AGENT_B_KEY || generatePrivateKey();
const agentA = privateKeyToAccount(agentAKey);
const agentB = privateKeyToAccount(agentBKey);
// 供应商钱包：演示时供应商要自己结算，所以需要私钥
const vendorAKey = env.VENDOR_A_KEY || generatePrivateKey();
const vendorBKey = env.VENDOR_B_KEY || generatePrivateKey();
const vendorA = privateKeyToAccount(vendorAKey).address;
const vendorB = privateKeyToAccount(vendorBKey).address;

async function send(label, request) {
  const hash = await wallet.writeContract({ address, abi, ...request });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} 失败：${hash}`);
  console.log(`  ${label}：${hash}`);
}

await send("存入团队预算", { functionName: "deposit", value: BUDGET });
await send("创建项目 甲·客服", { functionName: "createProject", args: ["客服项目", vendorA] });
await send("创建项目 乙·数据", { functionName: "createProject", args: ["数据项目", vendorB] });
await send("绑定 客服 Agent", {
  functionName: "addAgent",
  args: [agentA.address, 0n, "客服 Agent"],
});
await send("绑定 数据 Agent", {
  functionName: "addAgent",
  args: [agentB.address, 1n, "数据 Agent"],
});
await send("分配 甲", { functionName: "allocate", args: [0n, ALLOC_A] });
await send("分配 乙", { functionName: "allocate", args: [1n, ALLOC_B] });

for (const [label, a] of [
  ["客服 Agent", agentA],
  ["数据 Agent", agentB],
  ["客服供应商", privateKeyToAccount(vendorAKey)],
]) {
  const bal = await pub.getBalance({ address: a.address });
  if (bal < AGENT_GAS / 2n) {
    const hash = await wallet.sendTransaction({ to: a.address, value: AGENT_GAS });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  给 ${label} 发 gas ${formatEther(AGENT_GAS)} MON：${hash}`);
  }
}

setEnv("NEXT_PUBLIC_ENCUMBER_ADDRESS", address);
setEnv("AGENT_A_KEY", agentAKey);
setEnv("AGENT_B_KEY", agentBKey);
setEnv("VENDOR_A_KEY", vendorAKey);
setEnv("VENDOR_B_KEY", vendorBKey);
setEnv("VENDOR_A_ADDRESS", vendorA);
setEnv("VENDOR_B_ADDRESS", vendorB);
console.log(
  "✅ 已写入 apps/web/.env.local：NEXT_PUBLIC_ENCUMBER_ADDRESS、AGENT_A_KEY、AGENT_B_KEY、VENDOR_*",
);
console.log(`   客服 Agent ${agentA.address}，数据 Agent ${agentB.address}`);
