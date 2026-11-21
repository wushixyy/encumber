# AGENTS.md

适用于整个仓库。开发前阅读 [README.md](README.md)；版本、依赖和脚本以各级 `package.json` 为准。

## 工作边界

- 项目只有一个应用 `apps/web`（霸屏：玩家页、大屏页和 API），合约在 `contracts/`（Foundry）。项目规格见上级目录的 `docs/`。
- 使用 Bun Workspaces + Turborepo；依赖只用 Bun 管理，统一提交根目录 `bun.lock`。应用依赖用 `bun add --cwd apps/web <package>`，工具依赖放根目录。
- TypeScript 配置共享于 `packages/typescript-config`。源码放 `apps/web/src/`，`@/*` 指向 `src/*`。
- UI 封装按需放在 `src/components/ui/`，页面组合放在 `src/components/`。保留用户已有改动，不覆盖任务范围之外的代码。

## UI SDK：先查已安装版本文档

两端采用 [vercel-labs/ui](https://github.com/vercel-labs/ui) 的 `@ui-sdk/react` + `@ui-sdk/core`；两包保持相同精确版本，beta 升级时一起更新并复核文档。其他新增依赖优先选兼容的稳定版。

实现或修改 UI 前，以 `apps/web` 为起点，按顺序阅读：

1. `node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md`，及任务相关指南；已安装 `ui-sdk` 技能时同时遵循。
2. `node_modules/@ui-sdk/react/docs/llms.txt`，按需阅读 `docs/components/<name>.md`、`docs/server-rendering.md`、`docs/styling-and-animation.md`。
3. 仅在构建 SDK 缺失的组件或行为时，按标题查 `docs/core.md`，并阅读同目录 `rendering.md`；涉及 agent 能力时读技能中的 `references/agent-ready.md`。

按随包 `.d.ts` 核对 API，不套用其他组件库 API，不用 `dist/*.js` 代替文档。

## 组件、样式与无障碍

- 优先组合 SDK 组件；缺失行为通过 `@ui-sdk/core` 公开 API 按 primitive/React adapter 模式实现。React 按组件入口导入（如 `@ui-sdk/react/button`），不从根入口导入，不使用 `@ui-sdk/core/internal/*`。
- 遵循组件 Composition 的 Root/Part 嵌套；更换元素使用 `render`，自定义元素透传 props、事件和 ref。优先默认状态属性；需要受控时同时传值和回调，处理回调 `details`；列表 key 使用稳定值或 ID。
- 页面、布局和纯展示封装优先保持 Server Component；状态、事件、普通回调、render function、`createParts`、`usePart`、`usePrimitive` 放在适当的 `"use client"` 边界。引用 SDK 客户端组件不要求整页客户端化。弹层、焦点和 Portal 按文档管理，保持 SSR 与首次客户端渲染一致。
- 应用视觉样式统一使用 Tailwind utility，不加 CSS Modules、普通 CSS 选择器或内联 `style`。`globals.css` 中 `@layer ui-sdk;` 必须在 `@import "tailwindcss";` 前；不引入可选 `@ui-sdk/core/web.css`。使用 SDK 的 `data-*` 状态与公开 CSS 变量，SDK 自己的定位和隐藏样式交由 SDK 管理。
- 条件类名与外部样式用各应用 `@/lib/utils` 从官方 `cn` 包重新导出的 `cn` 合并，外部 `className` 放最后；静态类名直接用字符串。样式变体用 CVA 的 `cva` + `VariantProps`，再以 `cn(variants(props), className)` 合并。Oxfmt 已排序 `className`、`cn`、`cva` 中的 Tailwind 类名。
- 图标统一使用 Lucide React，优先从单图标公开入口导入（如 `lucide-react/icons/search`），类型从 `lucide-react/types` 导入；避免整库与无需求的动态加载。尺寸、颜色通过 Tailwind 控制，使用 `currentColor`；装饰图标保留 `aria-hidden`，仅图标按钮在按钮上命名，独立表意图标按 [官方指南](https://lucide.dev/how-to/accessibility) 命名。
- 保留 SDK 的角色、ARIA、焦点和键盘行为，不自行以 div/role 重写 SDK 已覆盖的交互。控件有可访问名称，优先 `FieldLabel`/`DialogTitle`，缺少可见名称时用 `aria-label`。保留可见焦点和足够点击区域；正文对比度至少 4.5:1，控件边界与焦点至少 3:1。
- UI 改动在真实浏览器验证布局、弹层、对比度与焦点；按组件文档检查 Tab、方向键、Enter、Space、Escape 和关闭后焦点恢复。自定义组件验证键盘、ARIA、SSR、RTL；agent 能力验证可访问名称与公开动作。

## 数据、认证与环境变量

- Zod 4 用于运行时校验，保持 TypeScript strict。schema 按需放各应用的 `src/lib/schemas/`，类型用 `z.infer` 推导，有转换时区分 `z.input`/`z.output`；核对 [官方文档](https://zod.dev/) 与已安装类型。
- Route Handler、Server Action、表单、URL 参数和外部数据均在服务端校验；客户端校验用于交互提示。预期非法输入用 `safeParse`，按字段返回筛选后的错误；客户端 schema 保持纯数据定义，数据库、认证密钥与服务端模块不进入客户端依赖链。
- 默认认证为 Better Auth，目前仅记录选型。接入前明确两端账号关系、会话共享或隔离、登录方式及管理员权限；接入后在服务端读写处校验会话和业务权限，普通登录不等于后台授权，跳转、隐藏按钮和 Proxy 不能替代权限校验。
- Drizzle ORM（两端）与 Drizzle Kit（根目录）已预装，数据库优先 Neon Postgres。实际接入时才添加驱动、连接、schema、迁移与所需环境变量；不添加依赖未配置文件的命令。单次查询优先评估 Neon HTTP，交互式事务或连接会话评估 Neon WebSocket Pool/Client 或 Node.js 的 `pg`；按 [README](README.md#后续库选型) 及官方文档核对事务能力和 Better Auth 适配器，迁移集中管理，开发测试优先独立 Neon 分支。共享服务端包随跨应用需求提取，UI 继续独立。
- 环境变量放各应用 `.env.local`，在同目录 `.env.example` 记录示例，接入实际服务后才添加 Zod 环境校验。同步维护 Turbo strict 配置：影响构建的进程变量放任务 `env`，仅运行时透传的变量按用途放 `passThroughEnv`，覆盖相应开发、构建和启动任务；不放宽为 loose 或全局 `*`。详见 [环境变量与缓存](README.md#环境变量与缓存)。

## 工具与验证

- 运行环境统一在根 `package.json` 维护：Node 用 `engines.node` 的兼容主版本范围，Bun 用 `packageManager`；CI 读取同一文件。本地安装满足要求的版本，根目录与两端的 Node 类型保持同一主版本，升级同步维护 README。
- 使用 Oxfmt、Oxlint、Knip，不引入 ESLint 或额外格式化工具。Knip 仅保留明确预装内容的有限豁免，开始使用后移除；两端进度不同时拆分工作区配置，保留配置提示检查，不扩大忽略范围。
- 完成修改运行 `bun check`；影响依赖、组件或构建配置时再运行 `bun run build`。报告实际检查结果和未验证部分。
- Vitest + React Testing Library 测试放各应用 `src/**/*.{test,spec}.{ts,tsx}`，使用自己的 `@/*`，从 `vitest` 显式导入 API。验证实际规则、组件行为与 SDK 接线，不写占位测试或重复测试 SDK 内部。
- Playwright 验证两端生产服务；首次安装用 `bun run test:e2e:install`，构建后用 `bun run test:e2e`。关键交互补充有意义的自动化测试，异步 Server Component 用 E2E 验证。测试与 CI 细节见 [README](README.md#测试与-ci)。
- 保留 CI 的冻结安装、检查、生产审计、构建与浏览器测试。生产审计没有豁免。全量审计只允许 README 已记录的公告继续，修复后移除对应豁免。

<!-- mojo:start -->

## MOJO 参赛提醒（由 MOJO skills 维护，勿手改）

- 活动：「Monad Blitz@广州」（eventId=18）
- 提交截止：2026-11-21 19:00（北京时间，UTC+8；ISO：2026-11-21T19:00:00+08:00）（现场与工作人员确认为 19:00）
- 活动类型：hackathon；加速阈值：剩余 ≤ 2 小时；冻结阈值：剩余 ≤ 30 分钟
- 每次开始工作先用系统时间算剩余时长，并告诉用户还剩多少。
- 剩余 ≤ 加速阈值：停止开新功能，优先让现有成果可运行、可演示，准备截图与项目描述。
- 剩余 ≤ 冻结阈值：先查项目是否已提交；没提交就立刻提交现有成果，已提交只做必要更新。
- 已过截止时间：删除本提醒块（AGENTS.md 与 CLAUDE.md 都删）。
- 怎么查、怎么提交：装了 MOJO skills 就用 mojo-submit；没装就读取 https://mojo.devnads.com/api/agent/instructions/18/skill.md 照做。凭证在 .mojo/agent.json。

<!-- mojo:end -->
