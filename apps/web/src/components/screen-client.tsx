"use client";

import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { holdTheScreenAbi } from "@/lib/abi";
import { CONTRACT_ADDRESS, formatMon, publicClient, shortAddress, txUrl } from "@/lib/chain";
import {
  KIND_IMAGE,
  KIND_VIDEO,
  SLOT_NAMES,
  type SlotState,
  isVacant,
  useSlots,
} from "@/lib/slots";

type FeedItem = {
  key: string;
  slotId: number;
  nickname: string;
  prevNickname: string | null;
  price: bigint;
  txHash: string;
};

const SLOT_WORDS = ["主位", "小格 1", "小格 2"];

function SlotCard({
  slot,
  big,
  hidden,
  onToggleHide,
  now,
}: {
  slot: SlotState | undefined;
  big: boolean;
  hidden: boolean;
  onToggleHide: () => void;
  now: number;
}) {
  const name = slot ? SLOT_NAMES[slot.id] : "";
  const vacant = !slot || isVacant(slot);
  const elapsed =
    slot && !vacant ? Math.max(0, Math.floor(now / 1000) - Number(slot.lastSettled)) : 0;
  const total = slot && !vacant ? Number(slot.secondsLeft) + elapsed : 1;
  const left = slot && !vacant ? Math.max(0, Number(slot.secondsLeft)) : 0;

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between px-5 pt-4">
        <span className={`font-black text-amber-400 ${big ? "text-2xl" : "text-lg"}`}>{name}</span>
        {!vacant && (
          <button
            type="button"
            onClick={onToggleHide}
            className="text-xs text-zinc-600 hover:text-zinc-300"
            aria-label={hidden ? `显示${name}内容` : `隐藏${name}内容`}
          >
            {hidden ? "显示" : "隐藏"}
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-5">
        {vacant ? (
          <div className="text-center">
            <div className={`font-black text-emerald-400 ${big ? "text-6xl" : "text-3xl"}`}>
              空位
            </div>
            <div className={`mt-2 text-zinc-400 ${big ? "text-2xl" : "text-base"}`}>扫码免费抢</div>
          </div>
        ) : hidden ? (
          <div className="text-xl text-zinc-500">内容已被主持人隐藏</div>
        ) : slot.kind === KIND_IMAGE ? (
          // oxlint-disable-next-line nextjs/no-img-element -- 用户上传的任意外链图片
          <img
            src={slot.content}
            alt={`${slot.nickname}的图片`}
            className="max-h-full max-w-full rounded-2xl object-contain"
          />
        ) : slot.kind === KIND_VIDEO ? (
          <video
            src={slot.content}
            autoPlay
            muted
            loop
            playsInline
            className="max-h-full max-w-full rounded-2xl object-contain"
          />
        ) : (
          <p
            className={`text-center font-black break-words text-white ${big ? "text-6xl leading-tight" : "text-2xl"}`}
          >
            {slot.content}
          </p>
        )}
      </div>

      {!vacant && (
        <div className="px-5 pb-4">
          <div className={`flex items-baseline justify-between ${big ? "text-xl" : "text-sm"}`}>
            <span className="truncate font-bold text-white">👑 {slot.nickname}</span>
            <span className="font-bold text-amber-400">{formatMon(slot.price)} MON</span>
          </div>
          <progress
            value={left}
            max={total}
            className="mt-2 h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-amber-400 [&::-webkit-progress-bar]:bg-zinc-800 [&::-webkit-progress-value]:bg-amber-400"
            aria-label="剩余霸屏时间"
          />
          <div className={`mt-1 text-zinc-400 ${big ? "text-base" : "text-xs"}`}>
            税金还能撑 {left} 秒
          </div>
        </div>
      )}
    </div>
  );
}

export function ScreenClient() {
  const { slots } = useSlots(1000);
  const [now, setNow] = useState(() => Date.now());
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<{ takeovers: bigint; prizePool: bigint } | null>(null);
  const [held, setHeld] = useState<Record<string, bigint>>({});
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  const [playUrl, setPlayUrl] = useState("");
  const lastBlock = useRef<bigint | null>(null);
  const namesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const first = setTimeout(() => setPlayUrl(`${window.location.origin}/play`), 0);
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);

  // 区块高度：300ms 出块，数字一直在跳
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        setBlockNumber(await publicClient.getBlockNumber({ cacheTime: 0 }));
      } catch {
        /* 忽略 */
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  // 抢屏事件：每 1.5 秒增量拉取
  useEffect(() => {
    if (!CONTRACT_ADDRESS) return;
    let stop = false;
    const tick = async () => {
      try {
        const latest = await publicClient.getBlockNumber({ cacheTime: 0 });
        const from =
          lastBlock.current === null ? (latest > 90n ? latest - 90n : 0n) : lastBlock.current + 1n;
        if (from > latest) return;
        const logs = await publicClient.getContractEvents({
          address: CONTRACT_ADDRESS!,
          abi: holdTheScreenAbi,
          eventName: "TakeOver",
          fromBlock: from,
          toBlock: latest,
        });
        lastBlock.current = latest;
        if (stop || logs.length === 0) return;
        const items: FeedItem[] = [];
        for (const log of logs) {
          const a = log.args;
          if (!a.newHolder) continue;
          const prev =
            a.prevHolder && a.prevHolder !== "0x0000000000000000000000000000000000000000"
              ? a.prevHolder
              : null;
          items.push({
            key: `${log.transactionHash}-${log.logIndex}`,
            slotId: Number(a.slotId ?? 0n),
            nickname: a.nickname || shortAddress(a.newHolder),
            prevNickname: prev ? namesRef.current[prev.toLowerCase()] || shortAddress(prev) : null,
            price: a.newPrice ?? 0n,
            txHash: log.transactionHash,
          });
          namesRef.current[a.newHolder.toLowerCase()] = a.nickname || shortAddress(a.newHolder);
        }
        setNames({ ...namesRef.current });
        setFeed((f) => [...items.reverse(), ...f].slice(0, 8));
      } catch {
        /* 忽略单次失败 */
      }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // 统计 + 排行榜（一次 multicall）
  useEffect(() => {
    if (!CONTRACT_ADDRESS) return;
    const tick = async () => {
      const addrs = Object.keys(namesRef.current) as Address[];
      try {
        const [takeovers, prizePool, secs] = await Promise.all([
          publicClient.readContract({
            address: CONTRACT_ADDRESS!,
            abi: holdTheScreenAbi,
            functionName: "totalTakeovers",
          }),
          publicClient.readContract({
            address: CONTRACT_ADDRESS!,
            abi: holdTheScreenAbi,
            functionName: "prizePool",
          }),
          addrs.length === 0
            ? Promise.resolve([] as bigint[])
            : publicClient
                .multicall({
                  allowFailure: false,
                  contracts: addrs.map((a) => ({
                    address: CONTRACT_ADDRESS!,
                    abi: holdTheScreenAbi,
                    functionName: "totalHeldSeconds" as const,
                    args: [a] as const,
                  })),
                })
                .catch(() => [] as bigint[]),
        ]);
        setStats({ takeovers, prizePool });
        setHeld(Object.fromEntries(addrs.map((a, i) => [a, secs[i]])));
      } catch {
        /* 忽略 */
      }
    };
    void tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);

  const leaderboard = useMemo(() => {
    const nowSec = BigInt(Math.floor(now / 1000));
    const totals: Record<string, bigint> = { ...held };
    const nameMap: Record<string, string> = { ...names };
    for (const s of slots ?? []) {
      if (isVacant(s)) continue;
      const k = s.holder.toLowerCase();
      totals[k] = (totals[k] ?? 0n) + (nowSec > s.lastSettled ? nowSec - s.lastSettled : 0n);
      if (!nameMap[k]) nameMap[k] = s.nickname;
    }
    return Object.entries(totals)
      .filter(([, v]) => v > 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, 5)
      .map(([addr, secs]) => ({ addr, name: nameMap[addr] || shortAddress(addr), secs }));
  }, [held, slots, names, now]);

  const participants = Object.keys(names).length;
  const hideKey = (s: SlotState | undefined) => (s ? `${s.id}:${s.holder}:${s.content}` : "");
  const toggleHide = (s: SlotState | undefined) => {
    const k = hideKey(s);
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  if (!CONTRACT_ADDRESS) {
    return <main className="p-6 text-white">合约地址未配置（NEXT_PUBLIC_CONTRACT_ADDRESS）</main>;
  }

  return (
    <main className="grid h-screen grid-cols-[1fr_22rem] gap-5 overflow-hidden bg-zinc-950 p-5 text-zinc-100">
      <div className="grid min-h-0 grid-rows-[1fr_14rem] gap-5">
        <SlotCard
          slot={slots?.[0]}
          big
          hidden={hiddenKeys.has(hideKey(slots?.[0]))}
          onToggleHide={() => toggleHide(slots?.[0])}
          now={now}
        />
        <div className="grid min-h-0 grid-cols-2 gap-5">
          {[1, 2].map((i) => (
            <SlotCard
              key={i}
              slot={slots?.[i]}
              big={false}
              hidden={hiddenKeys.has(hideKey(slots?.[i]))}
              onToggleHide={() => toggleHide(slots?.[i])}
              now={now}
            />
          ))}
        </div>
      </div>

      <aside className="flex min-h-0 flex-col gap-4">
        <div className="rounded-3xl bg-white p-4 text-center text-zinc-950">
          {playUrl && <QRCodeSVG value={playUrl} className="mx-auto h-44 w-44" />}
          <div className="mt-2 text-xl font-black">扫码抢屏</div>
          <div className="text-xs text-zinc-500">不用装钱包 · 价格你自己定</div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-2xl bg-zinc-900 p-3">
            <div className="text-2xl font-black text-amber-400">
              {stats?.takeovers.toString() ?? "–"}
            </div>
            <div className="text-xs text-zinc-400">抢屏次数</div>
          </div>
          <div className="rounded-2xl bg-zinc-900 p-3">
            <div className="text-2xl font-black text-amber-400">{participants}</div>
            <div className="text-xs text-zinc-400">参与人数</div>
          </div>
          <div className="rounded-2xl bg-zinc-900 p-3">
            <div className="text-2xl font-black text-amber-400">
              {stats ? formatMon(stats.prizePool, 4) : "–"}
            </div>
            <div className="text-xs text-zinc-400">奖池 MON</div>
          </div>
          <div className="rounded-2xl bg-zinc-900 p-3">
            <div className="font-mono text-lg font-black text-emerald-400">
              {blockNumber ? `#${blockNumber.toString()}` : "–"}
            </div>
            <div className="text-xs text-zinc-400">Monad 区块 · 300ms</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-3xl bg-zinc-900 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-bold">抢屏动态</span>
            {feed[0] && (
              <a
                href={txUrl(feed[0].txHash)}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-amber-400 px-3 py-1 text-xs font-bold text-zinc-950"
              >
                查看最新交易
              </a>
            )}
          </div>
          <ul className="space-y-2 text-sm">
            {feed.length === 0 && <li className="text-zinc-500">还没有人抢，第一个上！</li>}
            {feed.map((item) => (
              <li key={item.key} className="leading-snug">
                <span className="font-bold text-white">{item.nickname}</span>
                <span className="text-zinc-400"> 以 </span>
                <span className="text-amber-400">{formatMon(item.price)} MON</span>
                <span className="text-zinc-400"> 定价夺下{SLOT_WORDS[item.slotId]}</span>
                {item.prevNickname && (
                  <span className="text-zinc-500">，挤走了 {item.prevNickname}</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-3xl bg-zinc-900 p-4">
          <div className="mb-2 font-bold">霸屏时长榜</div>
          <ol className="space-y-1 text-sm">
            {leaderboard.length === 0 && <li className="text-zinc-500">虚位以待</li>}
            {leaderboard.map((row, i) => (
              <li key={row.addr} className="flex justify-between">
                <span className="truncate">
                  {i + 1}. {row.name}
                </span>
                <span className="text-amber-400">{row.secs.toString()} 秒</span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </main>
  );
}
