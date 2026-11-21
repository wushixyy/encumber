// 从 Foundry 编译产物生成前端用的 ABI（先在 contracts/ 里运行 forge build）
import { readFileSync, writeFileSync } from "node:fs";

const artifact = JSON.parse(
  readFileSync(
    new URL("../contracts/out/HoldTheScreen.sol/HoldTheScreen.json", import.meta.url),
    "utf8",
  ),
);
const out = `// 由 scripts/gen-abi.mjs 生成，不要手改
export const holdTheScreenAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;
`;
writeFileSync(new URL("../apps/web/src/lib/abi.ts", import.meta.url), out);
console.log("wrote apps/web/src/lib/abi.ts");

// Encumber（Agent 团队预算锁）
const enc = JSON.parse(
  readFileSync(new URL("../contracts/out/Encumber.sol/Encumber.json", import.meta.url), "utf8"),
);
writeFileSync(
  new URL("../apps/web/src/lib/encumber-abi.ts", import.meta.url),
  `// 由 scripts/gen-abi.mjs 生成，不要手改\nexport const encumberAbi = ${JSON.stringify(enc.abi, null, 2)} as const;\n`,
);
console.log("wrote apps/web/src/lib/encumber-abi.ts");
