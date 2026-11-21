# 霸屏 · Hold the Screen

**第一个用 Harberger 税给展示位定价的链上市场。** 会场大屏被切成 3 个链上广告位：你自己给广告位定价，按持有时间交占屏税；任何人付你的定价，就能当场把广告位买走。

Monad Blitz 广州（2026-11-21）参赛项目 · 运行在 Monad 测试网

- 🌐 在线体验：https://hold-the-screen.vercel.app （手机抢屏 `/play`，投影大屏 `/screen`）
- 📜 合约：[`0x32fFa7A7C942b4186D175b897D542399dBe8bc96`](https://testnet.monadvision.com/address/0x32fFa7A7C942b4186D175b897D542399dBe8bc96)（MonadVision、Monadscan 源码已验证）

## 玩法

1. 大屏上放二维码，观众扫码打开网页，**不用装钱包**：网页自动生成临时钱包并领取体验币
2. 填昵称，放上一句话、一张图或一段短视频，自己定一个价格，点“抢屏”
3. 内容一秒内出现在大屏上；别人付你的定价就能把屏抢走，**这笔钱和你没用完的税金都退给你**
4. 霸屏期间按“价格 × 每秒 1%”交占屏税，预存税金用完，广告位自动让位，变成空位

## 为什么是 Harberger 税

| 定价   | 好处         | 代价                   |
| ------ | ------------ | ---------------------- |
| 定得高 | 别人很难抢走 | 每秒交的税更多         |
| 定得低 | 省税         | 别人花很少的钱就能买走 |

没有最低加价、没有拍卖结束时间，价格可涨可跌，逼每个人报出自己心里的真实估价。现实中的“酒吧扫码霸屏”、直播间置顶都是固定价格、先到先得；霸屏把它变成实时的价格发现市场。

## 为什么在链上、为什么是 Monad

- **一笔交易原子完成**：付定价给上一任、转移展示权、税金按 70% / 30% 分给场地方和奖池，都在同一笔交易里，不需要信任平台事后分账
- **抢屏后一秒内大屏更新**：Monad 300ms 出块，玩家页用 `eth_sendRawTransactionSync`（viem `writeContractSync`）同步拿回执，实测确认约 0.8 到 1.5 秒
- **税金懒结算**：只在抢屏、追加、改价时一次性算清，不需要每秒上链

## 技术架构

```
手机 /play ──(临时钱包签名 takeOver)──▶ Monad 测试网 · HoldTheScreen 合约 ◀──(每秒读取)── 投影 /screen
   │
   ├─ /api/fund        服务端把新钱包攒批，调用 fundPlayers 一次发给多人
   └─ /api/upload-url  签发 Cloudflare R2 预签名地址，图片 / 视频从手机直传 R2，链上只存链接
```

| 部分        | 技术                                                  |
| ----------- | ----------------------------------------------------- |
| 合约        | Solidity 0.8 + Foundry（14 个测试）                   |
| 前端 / 接口 | Next.js 16、React 19、Tailwind 4、viem，部署在 Vercel |
| 媒体存储    | Cloudflare R2（预签名直传）                           |

### 合约要点（`contracts/src/HoldTheScreen.sol`）

- `takeOver(slotId, nickname, kind, content, newPrice)`：先懒结算上一任的税，付定价并退还剩余押金，余款作为新霸主的预存税金
- 税金用完强制断供：广告位变无主、价格归零
- 转账失败（比如对方是拒收的合约）自动记账，可自行 `withdraw()`，避免有人卡住广告位
- `getSlots()` 一次返回 3 个广告位的实时状态（剩余税金、倒计时按当前区块时间计算）
- 应对 Monad 的 Reserve Balance：主持人批量发币；玩家领币后等 2 秒、每次抢屏后冷却 2 秒

## 本地运行

```bash
bun install
cp apps/web/.env.example apps/web/.env.local   # 填写私钥、R2 等
bun run deploy                                 # 部署合约并写回合约地址
bun dev:web                                    # http://localhost:3000
```

```bash
cd contracts && forge test                     # 合约测试
bun run bots 5 300                             # 机器人观众（5 个，300 秒）
```

## 落地方向

- 线下活动、酒吧、Livehouse 的大屏展示位：固定价改成实时竞价、当场分账
- 同一套引擎适用于任何稀缺展示位：链上应用推荐位、直播间置顶、社群公告位
- 落地时可接入内容审核模型（现场版提供主持人一键隐藏）

所有代码均在活动当天编写，基于自有的 Next.js + Foundry 样板。
