# 霸屏 · Hold the Screen

会场大屏是一个链上广告位：你自己给屏幕定价，按这个价格每秒交占屏税；任何人只要付你的定价，就能把屏幕抢走。基于 Monad 测试网，Monad Blitz 广州参赛项目。

## 目录

```text
.
├── apps/web/            # Next.js 应用：玩家页 /play、大屏页 /screen、API
├── contracts/           # Foundry 合约项目
├── packages/            # 共享 TypeScript 配置
├── e2e/                 # Playwright 冒烟测试
└── tests/               # Vitest 公共 setup
```

## 环境要求

- Bun 1.4.4、Node.js 26.x
- Foundry（forge / cast）

## 前端

```bash
bun install
cp apps/web/.env.example apps/web/.env.local   # 然后填写变量
bun dev:web                                     # http://localhost:3000
bun run build                                   # 生产构建
```

## 合约

```bash
cd contracts
forge build
forge test
```

部署到 Monad 测试网（使用 `cast wallet import` 导入的钱包）：

```bash
forge create src/<合约>.sol:<合约名> --rpc-url monad_testnet --account monad-dev --broadcast
```

## Monad 测试网

| 项目     | 值                              |
| -------- | ------------------------------- |
| RPC      | `https://testnet-rpc.monad.xyz` |
| Chain ID | `10143`                         |
| 水龙头   | https://faucet.monad.xyz/       |
| 浏览器   | https://testnet.monadscan.com/  |

## 检查

```bash
bun check   # 格式 + Oxlint + 类型检查 + Knip + Vitest
```

基于自有的 Next.js + Bun + Turborepo 样板搭建。
