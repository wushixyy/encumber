// 第四幕准备：建一个「并发压测」项目，生成 N 个 Agent 钱包绑定到它，并给每个 Agent 发 gas
// 用法：node apps/web/scripts/setup-stress.mjs [Agent 数量=20]
// 写回 apps/web/.env.local：STRESS_PROJECT_ID、STRESS_AGENT_KEYS（逗号分隔）
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

const envPath = new URL("../.env.local", import.meta.url);
const artifact = JSON.parse(
  readFileSync(
    new URL("../../../contracts/out/Encumber.sol/Encumber.json", import.meta.url),
    "utf8",
  ),
);
const abi = artifact.abi;
const envText = readFileSync(envPath, "utf8");
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

const N = Number(process.argv[2] || 20);
const GAS_EACH = parseEther(process.env.STRESS_GAS || "0.1");
const address = env.NEXT_PUBLIC_ENCUMBER_ADDRESS;
const transport = http(env.NEXT_PUBLIC_RPC_URL || "https://testnet-rpc.monad.xyz", {
  timeout: 20_000,
  retryCount: 3,
});
const pub = createPublicClient({ chain: monadTestnet, transport });
const owner = createWalletClient({
  account: privateKeyToAccount(env.FUNDER_PRIVATE_KEY),
  chain: monadTestnet,
  transport,
});
const vendor = env.VENDOR_A_ADDRESS;

async function send(label, request) {
  const r = await owner.writeContractSync({ address, abi, ...request });
  if (r.status !== "success") throw new Error(`${label} 失败`);
  return r;
}

// --topup：不新建，只把已有的压测 Agent 补到每个 0.5 MON（演示前跑一次）
if (process.argv.includes("--topup")) {
  const target = parseEther(process.env.STRESS_TOPUP || "0.5");
  let n = 0;
  for (const k of (env.STRESS_AGENT_KEYS || "").split(",").filter(Boolean)) {
    const a = privateKeyToAccount(k).address;
    const bal = await pub.getBalance({ address: a });
    if (bal < target) {
      const r = await owner.sendTransactionSync({ to: a, value: target - bal });
      if (r.status !== "success") throw new Error(`补 gas 失败：${a}`);
      n += 1;
    }
  }
  console.log(`✅ 补充了 ${n} 个压测 Agent 的 gas（每个补到 ${Number(target) / 1e18} MON）`);
  process.exit(0);
}

const count = await pub.readContract({ address, abi, functionName: "projectCount" });
await send("创建并发压测项目", { functionName: "createProject", args: ["并发压测", vendor] });
const projectId = count;
console.log(`✅ 并发压测项目 #${projectId}`);

const keys = Array.from({ length: N }, () => generatePrivateKey());
for (let i = 0; i < N; i++) {
  const a = privateKeyToAccount(keys[i]);
  await send(`绑定 Agent ${i + 1}`, {
    functionName: "addAgent",
    args: [a.address, projectId, `Agent ${i + 1}`],
  });
  const r = await owner.sendTransactionSync({ to: a.address, value: GAS_EACH });
  if (r.status !== "success") throw new Error(`给 Agent ${i + 1} 发 gas 失败`);
  process.stdout.write(`  Agent ${i + 1}/${N} 已绑定并发放 gas\r`);
}
console.log("");
setEnv("STRESS_PROJECT_ID", projectId.toString());
setEnv("STRESS_AGENT_KEYS", keys.join(","));
console.log(`✅ 已写入 STRESS_PROJECT_ID=${projectId}、STRESS_AGENT_KEYS（${N} 个）`);
