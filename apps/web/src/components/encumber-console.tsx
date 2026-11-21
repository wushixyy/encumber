"use client";

import { useCallback, useEffect, useState } from "react";
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

const SCENES: { title: string; desc: string; steps: { label: string; body: object }[] }[] = [
  {
    title: "准备",
    desc: "新开一轮：团队预算 0.1，甲 0.06、乙 0.04；乙花完，甲花到只剩 0.02",
    steps: [
      { label: "① 新开一轮", body: { step: "reset" } },
      { label: "② 开场花费", body: { step: "setup" } },
    ],
  },
  {
    title: "幕一 · 被预占的钱挪不走",
    desc: "客服 Agent 调用大模型前预占 0.02，财务想把这 0.02 调给乙",
    steps: [
      { label: "Agent 预占 0.02", body: { step: "reserve" } },
      { label: "财务调拨 0.02（应被拦）", body: { step: "reallocate" } },
    ],
  },
  {
    title: "幕二 · 按实际结算，剩余自动释放",
    desc: "实际只花了 0.012，剩下的 0.008 释放回甲，马上可以调拨",
    steps: [
      { label: "Agent 结算 0.012", body: { step: "settle" } },
      { label: "财务调拨释放的 0.008", body: { step: "realloc-released" } },
    ],
  },
  {
    title: "幕三 · 付款和调拨同时发生",
    desc: "先「新开一轮 + 开场花费」，再让 Agent 付款和财务调拨同时提交，按链上顺序判定",
    steps: [
      { label: "付款先发", body: { step: "race", first: "pay" } },
      { label: "调拨先发", body: { step: "race", first: "reallocate" } },
    ],
  },
];

function Bar({ p }: { p: Project }) {
  const total = p.allocated === 0n ? 1n : p.allocated;
  const pct = (v: bigint) => `${Number((v * 10000n) / total) / 100}%`;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-800" aria-hidden>
      <div className="bg-rose-500" style={{ width: pct(p.spent) }} />
      <div className="bg-amber-400" style={{ width: pct(p.reserved) }} />
      <div className="bg-emerald-500" style={{ width: pct(p.available) }} />
    </div>
  );
}

export function EncumberConsole() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [owner, setOwner] = useState<string>("");
  const [unallocated, setUnallocated] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<StepResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!ADDRESS) return;
    try {
      const base = { address: ADDRESS, abi: encumberAbi } as const;
      const [ps, acts, own, un] = await Promise.all([
        publicClient.readContract({ ...base, functionName: "getProjects" }),
        publicClient.readContract({ ...base, functionName: "getActivities" }),
        publicClient.readContract({ ...base, functionName: "owner" }),
        publicClient.readContract({ ...base, functionName: "unallocated" }),
      ]);
      setProjects(ps.slice(-2) as unknown as Project[]);
      setActivities([...acts] as Activity[]);
      setOwner(own);
      setUnallocated(un);
      const unknown = [...new Set(acts.map((a) => a.actor))].filter(
        (a) => a.toLowerCase() !== own.toLowerCase() && !(a.toLowerCase() in names),
      );
      if (unknown.length) {
        const ns = await Promise.all(
          unknown.map((a) =>
            publicClient.readContract({ ...base, functionName: "agentName", args: [a] }),
          ),
        );
        setNames((prev) => {
          const next = { ...prev };
          unknown.forEach((a, i) => (next[a.toLowerCase()] = ns[i] || shortAddress(a)));
          return next;
        });
      }
    } catch {
      /* 忽略单次失败 */
    }
  }, [names]);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh]);

  async function run(label: string, body: object) {
    setBusy(label);
    setError(null);
    try {
      const r = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as { steps?: StepResult[]; error?: string };
      if (!r.ok || !data.steps) throw new Error(data.error || "执行失败");
      setResults(data.steps);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const actorName = (a: string) =>
    a.toLowerCase() === owner.toLowerCase() ? "财务" : names[a.toLowerCase()] || shortAddress(a);
  const projectName = (id: number) => {
    const p = projects.find((x) => Number(x.id) === id);
    return p ? (Number(p.id) === Number(projects[0]?.id) ? "甲" : "乙") : `#${id}`;
  };

  if (!ADDRESS) {
    return <main className="p-6 text-white">合约地址未配置（NEXT_PUBLIC_ENCUMBER_ADDRESS）</main>;
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-6 text-zinc-100">
      <header className="mx-auto mb-6 flex max-w-6xl items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">
            预算锁 <span className="text-amber-400">Encumber</span>
          </h1>
          <p className="mt-1 text-zinc-400">
            Agent 团队的链上项目预算：被预占的钱谁也挪不走，已调走的钱 Agent
            也花不了，账始终对得上。
          </p>
        </div>
        <a
          href={`${EXPLORER}/address/${ADDRESS}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
        >
          合约 {shortAddress(ADDRESS)} ↗
        </a>
      </header>

      <section className="mx-auto max-w-6xl rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">项目预算（链上实时）</h2>
          <div className="flex gap-4 text-xs text-zinc-400">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              已花
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              已预占
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              可用
            </span>
            <span>金库未分配 {formatMon(unallocated)} MON</span>
          </div>
        </div>
        <table className="w-full text-left">
          <thead className="text-sm text-zinc-400">
            <tr>
              <th className="py-2 font-normal">项目</th>
              <th className="py-2 text-right font-normal">已分配</th>
              <th className="py-2 text-right font-normal">已预占</th>
              <th className="py-2 text-right font-normal">已花</th>
              <th className="py-2 text-right font-normal">可用</th>
              <th className="w-1/3 py-2 pl-6 font-normal">构成</th>
            </tr>
          </thead>
          <tbody className="text-xl tabular-nums">
            {projects.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-base text-zinc-500">
                  还没有项目，点「新开一轮」
                </td>
              </tr>
            )}
            {projects.map((p, i) => (
              <tr key={p.id.toString()} className="border-t border-zinc-800">
                <td className="py-4 font-bold">
                  {i === 0 ? "甲 · " : "乙 · "}
                  {p.name}
                </td>
                <td className="py-4 text-right">{formatMon(p.allocated)}</td>
                <td className="py-4 text-right text-amber-400">{formatMon(p.reserved)}</td>
                <td className="py-4 text-right text-rose-400">{formatMon(p.spent)}</td>
                <td className="py-4 text-right font-bold text-emerald-400">
                  {formatMon(p.available)}
                </td>
                <td className="py-4 pl-6">
                  <Bar p={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-zinc-500">
          规则：调拨只能动「可用」；预占的钱结算前谁也挪不走；已花的留在原项目。单位
          MON，每秒从合约读取。
        </p>
      </section>

      <div className="mx-auto mt-6 grid max-w-6xl gap-6 lg:grid-cols-[1fr_1fr]">
        <section className="space-y-3">
          {SCENES.map((scene) => (
            <div key={scene.title} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="font-bold">{scene.title}</div>
              <div className="mt-1 text-sm text-zinc-400">{scene.desc}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {scene.steps.map((s) => (
                  <button
                    type="button"
                    key={s.label}
                    disabled={!!busy}
                    onClick={() => run(s.label, s.body)}
                    className="rounded-xl bg-amber-400 px-3 py-2 text-sm font-bold text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400"
                  >
                    {busy === s.label ? "上链中…" : s.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 font-bold">本次操作结果</div>
            {error && (
              <div className="mb-2 rounded-lg bg-rose-950 px-3 py-2 text-sm text-rose-300">
                {error}
              </div>
            )}
            {results.length === 0 && !error && (
              <div className="text-sm text-zinc-500">点左边的按钮开始</div>
            )}
            <ul className="space-y-2 text-sm">
              {results.map((r) => (
                <li key={r.hash} className="flex items-start justify-between gap-3">
                  <span>
                    {r.ok ? "✅" : "⛔"} {r.label}
                    {!r.ok && r.reason && <span className="text-rose-400">：{r.reason}</span>}
                  </span>
                  <a
                    href={txUrl(r.hash)}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-zinc-400 underline"
                  >
                    区块 {r.block} · 第 {r.index} 笔 ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-2 font-bold">链上活动记录（含拦截原因）</div>
            <ul className="space-y-1 text-sm">
              {activities.length === 0 && <li className="text-zinc-500">暂无</li>}
              {activities.slice(0, 14).map((a, i) => (
                <li
                  key={`${a.blockNumber}-${i}`}
                  className="flex justify-between gap-3 tabular-nums"
                >
                  <span>
                    {a.reason === 0 ? "✅" : "⛔"} {actorName(a.actor)} · {ACTIONS[a.action]}
                    {a.action === 2 &&
                      ` ${projectName(a.fromProject)}→${projectName(a.toProject)}`}{" "}
                    {formatMon(a.amount)}
                    {a.reason !== 0 && (
                      <span className="text-rose-400">（{REASONS[a.reason]}）</span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500">
                    区块 {a.blockNumber.toString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}
