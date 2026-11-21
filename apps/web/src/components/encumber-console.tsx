"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { formatMon, publicClient, shortAddress, txUrl } from "@/lib/chain";
import { encumberAbi } from "@/lib/encumber-abi";

const ADDRESS = (process.env.NEXT_PUBLIC_ENCUMBER_ADDRESS || undefined) as Address | undefined;
const EXPLORER = "https://testnet.monadexplorer.com";

const ACTIONS = ["存入预算", "分配预算", "项目调拨", "预占", "结算", "释放", "付款"];
const REASONS = [
  "",
  "调用者不是 Agent",
  "可用余额不足",
  "这笔钱已被预占",
  "不是这笔预占的 Agent",
  "预占已结算或释放",
  "实际花费超过预占上限",
  "项目不存在",
];

type Project = {
  id: bigint;
  name: string;
  allocated: bigint;
  reserved: bigint;
  spent: bigint;
  available: bigint;
};
type Activity = {
  time: bigint;
  blockNumber: bigint;
  action: number;
  reason: number;
  actor: Address;
  fromProject: number;
  toProject: number;
  amount: bigint;
};
type StepResult = {
  label: string;
  hash: string;
  block: string;
  index: number;
  ok: boolean;
  reason?: string;
};

type Beat = {
  act: string;
  title: string;
  story: string;
  body: Record<string, string>;
  expect: "ok" | "blocked" | "race";
};

/** 自动演示的剧本：每一步都有旁白，评委不用提问也能看懂 */
const SCRIPT: Beat[] = [
  {
    act: "准备",
    title: "团队给两个项目分预算",
    story:
      "团队金库存入 0.1 MON：客服项目（甲）0.06，数据项目（乙）0.04。每个项目绑定自己的 AI Agent。",
    body: { step: "reset" },
    expect: "ok",
  },
  {
    act: "准备",
    title: "Agent 们开始花钱",
    story: "数据 Agent 花光了乙的 0.04；客服 Agent 花了 0.04，甲只剩 0.02。",
    body: { step: "setup" },
    expect: "ok",
  },
  {
    act: "幕一",
    title: "Agent 调用大模型前，先预占 0.02",
    story: "按 token 计费，事先不知道要花多少，所以先锁住上限。这 0.02 现在处于「已预占」状态。",
    body: { step: "reserve" },
    expect: "ok",
  },
  {
    act: "幕一",
    title: "财务想把甲这 0.02 调给乙",
    story: "乙的钱花完了，财务想挪甲的。但这笔钱已被 Agent 预占，合约会拦下吗？",
    body: { step: "reallocate" },
    expect: "blocked",
  },
  {
    act: "幕二",
    title: "Agent 按实际花费 0.012 结算",
    story: "任务完成，实际只花了 0.012。合约付款给服务商，剩下的 0.008 自动释放回甲的「可用」。",
    body: { step: "settle" },
    expect: "ok",
  },
  {
    act: "幕二",
    title: "财务调拨释放出来的 0.008",
    story: "这次只调「未花且未预占」的部分。已花的 0.052 永远留在甲的账上。",
    body: { step: "realloc-released" },
    expect: "ok",
  },
  {
    act: "幕三",
    title: "新开一轮，摆好同样的局面",
    story: "重新分配预算：甲 0.06、乙 0.04。",
    body: { step: "reset" },
    expect: "ok",
  },
  {
    act: "幕三",
    title: "付款和调拨同时发生",
    story:
      "甲只剩 0.02：Agent 要付这 0.02，财务同时要调走这 0.02。两笔交易一起发出，同一份钱只能用一次。",
    body: { step: "race", first: "pay" },
    expect: "race",
  },
];

function Bar({ p }: { p: Project }) {
  const total = p.allocated === 0n ? 1n : p.allocated;
  const pct = (v: bigint) => `${Number((v * 10000n) / total) / 100}%`;
  return (
    <div className="flex h-7 w-full overflow-hidden rounded-xl bg-zinc-800/80 ring-1 ring-white/5">
      <div
        className="h-full bg-gradient-to-r from-rose-600 to-rose-400 transition-all duration-700"
        style={{ width: pct(p.spent) }}
      />
      <div
        className="animate-stripes h-full bg-amber-400 bg-[repeating-linear-gradient(45deg,rgba(0,0,0,0.25)_0_7px,transparent_7px_14px)] bg-[length:28px_28px] transition-all duration-700"
        style={{ width: pct(p.reserved) }}
      />
      <div
        className="h-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-700"
        style={{ width: pct(p.available) }}
      />
    </div>
  );
}

function ProjectCard({ p, tag }: { p: Project; tag: string }) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-zinc-900/70 p-6 shadow-2xl shadow-black/40 backdrop-blur">
      <div className="pointer-events-none absolute -top-16 -right-16 h-40 w-40 rounded-full bg-amber-400/10 blur-3xl" />
      <div className="flex items-baseline justify-between">
        <div>
          <span className="mr-2 rounded-lg bg-white/10 px-2 py-0.5 text-sm font-black text-amber-300">
            {tag}
          </span>
          <span className="text-2xl font-black">{p.name}</span>
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-400">可用</div>
          <div className="text-4xl font-black text-emerald-400 tabular-nums">
            {formatMon(p.available)}
          </div>
        </div>
      </div>
      <div className="mt-5">
        <Bar p={p} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-2xl bg-rose-500/10 py-2">
          <div className="text-xs text-rose-300">已花（留在本项目）</div>
          <div className="text-xl font-bold text-rose-300 tabular-nums">{formatMon(p.spent)}</div>
        </div>
        <div className="rounded-2xl bg-amber-400/10 py-2">
          <div className="text-xs text-amber-300">🔒 已预占（谁也挪不走）</div>
          <div className="text-xl font-bold text-amber-300 tabular-nums">
            {formatMon(p.reserved)}
          </div>
        </div>
        <div className="rounded-2xl bg-white/5 py-2">
          <div className="text-xs text-zinc-400">已分配</div>
          <div className="text-xl font-bold tabular-nums">{formatMon(p.allocated)}</div>
        </div>
      </div>
    </div>
  );
}

export function EncumberConsole() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [owner, setOwner] = useState<string>("");
  const [block, setBlock] = useState<bigint | null>(null);
  const [beatIndex, setBeatIndex] = useState<number>(-1);
  const [running, setRunning] = useState(false);
  const [lastSteps, setLastSteps] = useState<StepResult[]>([]);
  const [banner, setBanner] = useState<{
    kind: "ok" | "blocked";
    text: string;
    key: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);
  const namesRef = useRef<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!ADDRESS) return;
    try {
      const base = { address: ADDRESS, abi: encumberAbi } as const;
      const [ps, acts, own] = await Promise.all([
        publicClient.readContract({ ...base, functionName: "getProjects" }),
        publicClient.readContract({ ...base, functionName: "getActivities" }),
        publicClient.readContract({ ...base, functionName: "owner" }),
      ]);
      setProjects(ps.slice(-2) as unknown as Project[]);
      setActivities([...acts] as Activity[]);
      setOwner(own);
      const unknown = [...new Set(acts.map((a) => a.actor.toLowerCase()))].filter(
        (a) => a !== own.toLowerCase() && !(a in namesRef.current),
      );
      if (unknown.length) {
        const ns = await Promise.all(
          unknown.map((a) =>
            publicClient.readContract({ ...base, functionName: "agentName", args: [a as Address] }),
          ),
        );
        unknown.forEach((a, i) => (namesRef.current[a] = ns[i] || shortAddress(a)));
        setNames({ ...namesRef.current });
      }
    } catch {
      /* 忽略单次失败 */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 1000);
    const b = setInterval(async () => {
      try {
        setBlock(await publicClient.getBlockNumber({ cacheTime: 0 }));
      } catch {
        /* 忽略 */
      }
    }, 400);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      clearInterval(b);
    };
  }, [refresh]);

  async function runBeat(i: number): Promise<boolean> {
    const beat = SCRIPT[i];
    setBeatIndex(i);
    setError(null);
    setLastSteps([]); // 新的一步开始，先清掉上一步的交易，避免面板显示旧数据
    try {
      const r = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(beat.body),
      });
      const data = (await r.json()) as { steps?: StepResult[]; error?: string };
      if (!r.ok || !data.steps) throw new Error(data.error || "执行失败");
      setLastSteps(data.steps);
      const last = data.steps.at(-1);
      if (beat.expect === "race") {
        const race = data.steps.slice(-2);
        const winner = race.find((s) => s.ok);
        const loser = race.find((s) => !s.ok);
        setBanner({
          kind: "blocked",
          text: `${winner?.label ?? ""} 先上链 ✅ · ${loser?.label ?? ""} 被拦（${loser?.reason ?? ""}）`,
          key: Date.now(),
        });
      } else if (last && !last.ok) {
        setBanner({
          kind: "blocked",
          text: `合约拦截：${last.reason ?? "被拒绝"}`,
          key: Date.now(),
        });
      } else if (last) {
        setBanner({ kind: "ok", text: `${last.label} · 已上链`, key: Date.now() });
      }
      void refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function autoplay() {
    setRunning(true);
    stopRef.current = false;
    for (let i = 0; i < SCRIPT.length; i++) {
      if (stopRef.current) break;
      const ok = await runBeat(i);
      if (!ok) break;
      await new Promise((r) => setTimeout(r, 2200)); // 给观众读旁白的时间
    }
    setRunning(false);
  }

  async function single(i: number) {
    setRunning(true);
    await runBeat(i);
    setRunning(false);
  }

  const actorName = (a: string) =>
    a.toLowerCase() === owner.toLowerCase() ? "财务" : names[a.toLowerCase()] || shortAddress(a);
  const tagOf = (id: number) => {
    if (projects.length !== 2) return `#${id}`;
    if (id === Number(projects[0].id)) return "甲";
    if (id === Number(projects[1].id)) return "乙";
    return `#${id}`;
  };

  const beat = beatIndex >= 0 ? SCRIPT[beatIndex] : null;
  const raceSteps = beat?.expect === "race" ? lastSteps.slice(-2) : [];

  if (!ADDRESS) {
    return <main className="p-6 text-white">合约地址未配置（NEXT_PUBLIC_ENCUMBER_ADDRESS）</main>;
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      {/* 背景：网格 + 光晕 */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="animate-glow pointer-events-none absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-violet-600/20 blur-3xl" />
      <div className="animate-glow pointer-events-none absolute top-1/3 -right-32 h-96 w-96 rounded-full bg-amber-500/10 blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-6 py-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs font-bold tracking-[0.3em] text-violet-300">
              AGENT TEAM BUDGET · ON MONAD
            </div>
            <h1 className="mt-1 text-4xl font-black tracking-tight">
              预算锁{" "}
              <span className="bg-gradient-to-r from-amber-300 to-orange-500 bg-clip-text text-transparent">
                Encumber
              </span>
            </h1>
            <p className="mt-1 text-zinc-300">
              多个 AI Agent 共用项目预算时：<b className="text-amber-300">被预占的钱谁也挪不走</b>，
              <b className="text-emerald-300">已调走的钱 Agent 也花不了</b>，账始终对得上。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-sm">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              <span className="font-mono text-emerald-300 tabular-nums">
                Monad 测试网 #{block ? block.toString() : "…"}
              </span>
            </div>
            <a
              href={`${EXPLORER}/address/${ADDRESS}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-white/15 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5"
            >
              合约 {shortAddress(ADDRESS)} ↗
            </a>
          </div>
        </header>

        {/* 旁白区 */}
        <section className="mt-6 grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="rounded-3xl border border-violet-400/20 bg-gradient-to-br from-violet-500/15 to-zinc-900/60 p-5">
            {beat ? (
              <div key={beatIndex} className="animate-rise">
                <div className="text-sm font-bold text-violet-300">
                  {beat.act} · 第 {beatIndex + 1} / {SCRIPT.length} 步
                </div>
                <div className="mt-1 text-2xl font-black">{beat.title}</div>
                <div className="mt-1 text-zinc-300">{beat.story}</div>
              </div>
            ) : (
              <div>
                <div className="text-sm font-bold text-violet-300">问题</div>
                <div className="mt-1 text-2xl font-black">
                  财务调预算的同时，Agent 正在花同一笔钱，算谁的？
                </div>
                <div className="mt-1 text-zinc-300">
                  点「一键演示」，三幕看合约如何用「已花 / 已预占 /
                  可用」三态账本，保证同一份预算只被承诺一次。
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col justify-center gap-2">
            <button
              type="button"
              disabled={running}
              onClick={autoplay}
              className="rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 px-8 py-4 text-xl font-black text-zinc-950 shadow-lg shadow-orange-500/30 transition hover:scale-105 disabled:scale-100 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-400 disabled:shadow-none"
            >
              {running ? "演示进行中…" : "▶ 一键演示"}
            </button>
            {running && (
              <button
                type="button"
                onClick={() => (stopRef.current = true)}
                className="text-sm text-zinc-400 underline"
              >
                本步完成后停止
              </button>
            )}
          </div>
        </section>

        {/* 结果横幅 */}
        {banner && (
          <div
            key={banner.key}
            className={`mt-4 rounded-2xl px-5 py-3 text-xl font-black ${
              banner.kind === "blocked"
                ? "animate-shake border border-rose-400/40 bg-rose-500/15 text-rose-200"
                : "animate-rise border border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
            }`}
          >
            {banner.kind === "blocked" ? "⛔ " : "✅ "}
            {banner.text}
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-2xl border border-rose-400/40 bg-rose-950 px-5 py-3 text-rose-200">
            出错了：{error}
          </div>
        )}

        {/* 第一屏：两个项目 */}
        <section className="mt-6 grid gap-5 md:grid-cols-2">
          {projects.length === 2 ? (
            projects.map((p, i) => (
              <ProjectCard key={p.id.toString()} p={p} tag={i === 0 ? "甲" : "乙"} />
            ))
          ) : (
            <div className="rounded-3xl border border-white/10 bg-zinc-900/70 p-6 text-zinc-400 md:col-span-2">
              还没有项目，点「一键演示」开始
            </div>
          )}
        </section>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.1fr_1fr]">
          {/* 同块对决 / 本步交易 */}
          <section className="rounded-3xl border border-white/10 bg-zinc-900/70 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-black">
                {raceSteps.length === 2 ? "⚔️ 同一份钱，两笔交易" : "本步上链交易"}
              </h2>
              <span className="text-xs text-zinc-500">点击可在区块浏览器核对</span>
            </div>
            {raceSteps.length === 2 ? (
              <div className="space-y-3">
                {raceSteps.map((s) => (
                  <a
                    key={s.hash}
                    href={txUrl(s.hash)}
                    target="_blank"
                    rel="noreferrer"
                    className={`animate-rise flex items-center justify-between rounded-2xl border px-4 py-4 ${
                      s.ok
                        ? "border-emerald-400/40 bg-emerald-500/10"
                        : "border-rose-400/40 bg-rose-500/10"
                    }`}
                  >
                    <span className="text-lg font-bold">
                      {s.ok ? "✅" : "⛔"} {s.label}
                      {!s.ok && <span className="ml-2 text-base text-rose-300">{s.reason}</span>}
                    </span>
                    <span className="font-mono text-sm text-zinc-300">
                      区块 #{s.block} · 第 {s.index} 笔
                    </span>
                  </a>
                ))}
                <p className="text-sm text-zinc-400">
                  {raceSteps[0].block === raceSteps[1].block
                    ? "两笔落在同一个区块，合约按区块内顺序判定：先到的成功，后到的被拦，账一分不差。"
                    : "两笔几乎同时发出，合约按上链顺序判定：先到的成功，后到的被拦，账一分不差。"}
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {lastSteps.length === 0 && <li className="text-sm text-zinc-500">还没有交易</li>}
                {lastSteps.map((s) => (
                  <li key={s.hash}>
                    <a
                      href={txUrl(s.hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-3 rounded-xl bg-white/5 px-3 py-2 text-sm hover:bg-white/10"
                    >
                      <span>
                        {s.ok ? "✅" : "⛔"} {s.label}
                        {!s.ok && s.reason && <span className="text-rose-300">：{s.reason}</span>}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-zinc-400">
                        #{s.block} · 第 {s.index} 笔 ↗
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}

            <details className="mt-4 text-sm text-zinc-400">
              <summary className="cursor-pointer select-none">手动单步</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {SCRIPT.map((b, i) => (
                  <button
                    type="button"
                    key={`${b.title}-${b.act}`}
                    disabled={running}
                    onClick={() => single(i)}
                    className="rounded-lg border border-white/10 px-2 py-1 text-xs hover:bg-white/5 disabled:opacity-40"
                  >
                    {i + 1}. {b.title}
                  </button>
                ))}
              </div>
            </details>
          </section>

          {/* 链上活动时间线 */}
          <section className="rounded-3xl border border-white/10 bg-zinc-900/70 p-5">
            <h2 className="mb-3 text-lg font-black">链上活动记录 · 拒绝也上链</h2>
            <ol className="space-y-1.5">
              {activities.length === 0 && <li className="text-sm text-zinc-500">暂无</li>}
              {activities.slice(0, 11).map((a) => (
                <li
                  key={`${a.blockNumber}-${a.action}-${a.actor}-${a.amount}`}
                  className={`flex items-center justify-between gap-3 rounded-xl px-3 py-1.5 text-sm tabular-nums ${
                    a.reason === 0 ? "bg-white/5" : "bg-rose-500/10"
                  }`}
                >
                  <span>
                    {a.reason === 0 ? "✅" : "⛔"} <b>{actorName(a.actor)}</b> · {ACTIONS[a.action]}
                    {a.action === 2 && ` ${tagOf(a.fromProject)}→${tagOf(a.toProject)}`}{" "}
                    {formatMon(a.amount)}
                    {a.reason !== 0 && (
                      <span className="text-rose-300">（{REASONS[a.reason]}）</span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-zinc-500">
                    #{a.blockNumber.toString()}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="mt-6 text-center text-xs text-zinc-500">
          规则写在合约里：调拨只动「可用」· 预占结算前谁也挪不走 · 已花的留在原项目 ·
          被拒的操作带原因上链 · Monad 测试网 300ms 出块，状态每秒刷新
        </footer>
      </div>
    </main>
  );
}
