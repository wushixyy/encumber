"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Address,
  type EIP1193Provider,
  type WalletClient,
  createWalletClient,
  custom,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { holdTheScreenAbi } from "@/lib/abi";
import {
  CONTRACT_ADDRESS,
  formatMon,
  monadTestnet,
  publicClient,
  shortAddress,
  transport,
  txUrl,
} from "@/lib/chain";
import {
  KIND_IMAGE,
  KIND_LABELS,
  KIND_TEXT,
  KIND_VIDEO,
  MIN_PRICE,
  SLOT_NAMES,
  isVacant,
  taxPerSecond,
  useSlots,
} from "@/lib/slots";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

type WalletMode = "burner" | "injected";
type FundStatus = "idle" | "funding" | "warming" | "ready" | "error";

const PK_KEY = "hts:burner-pk";
const NICK_KEY = "hts:nickname";
const COOLDOWN_MS = 2000;
const GAS_RESERVE = parseEther("0.03");
const MAX_TEXT = 40;

function loadBurner() {
  let pk = localStorage.getItem(PK_KEY) as `0x${string}` | null;
  if (!pk) {
    pk = generatePrivateKey();
    localStorage.setItem(PK_KEY, pk);
  }
  return privateKeyToAccount(pk);
}

function errorText(e: unknown): string {
  const msg =
    e instanceof Error
      ? (e as Error & { shortMessage?: string }).shortMessage || e.message
      : String(e);
  if (/insufficient funds/i.test(msg)) return "余额不够，等发币到账或少付一点押金";
  if (/InsufficientPayment/.test(msg)) return "付的钱不够：价格刚被别人改了，刷新后再试";
  if (/User rejected|denied/i.test(msg)) return "你取消了签名";
  return msg.split("\n")[0].slice(0, 160);
}

export function PlayClient() {
  const { slots, refresh } = useSlots(1000);

  const [mode, setMode] = useState<WalletMode>("burner");
  const [address, setAddress] = useState<Address | null>(null);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [balance, setBalance] = useState<bigint>(0n);
  const [fundStatus, setFundStatus] = useState<FundStatus>("idle");

  const [nickname, setNickname] = useState("");
  const [slotId, setSlotId] = useState(0);
  const [kind, setKind] = useState(KIND_TEXT);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [priceInput, setPriceInput] = useState("0.01");
  const [depositSeconds, setDepositSeconds] = useState(60);

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string; tx?: string } | null>(
    null,
  );
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // 临时钱包 + 昵称
  useEffect(() => {
    const account = loadBurner();
    setAddress(account.address);
    setWallet(createWalletClient({ account, chain: monadTestnet, transport }));
    setNickname(localStorage.getItem(NICK_KEY) ?? "");
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // 余额轮询
  useEffect(() => {
    if (!address) return;
    let stop = false;
    const tick = async () => {
      try {
        const b = await publicClient.getBalance({ address });
        if (!stop) setBalance(b);
      } catch {
        /* 忽略单次失败 */
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [address]);

  // 临时钱包自动领币；新到账的钱约 3 个区块后才能用，所以等 2 秒再解锁
  useEffect(() => {
    if (mode !== "burner" || !address || fundStatus !== "idle") return;
    setFundStatus("funding");
    fetch("/api/fund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    })
      .then(async (r) => {
        const data = (await r.json()) as { status?: string; error?: string };
        if (!r.ok) throw new Error(data.error || "发币失败");
        setFundStatus("warming");
        setTimeout(() => setFundStatus("ready"), data.status === "funded" ? 2000 : 0);
      })
      .catch((e) => {
        setFundStatus("error");
        setMessage({ kind: "err", text: errorText(e) });
      });
  }, [mode, address, fundStatus]);

  const slot = slots?.[slotId];

  // 切换广告位时给一个建议价：无主 0.01，有主就是当前价的 1.2 倍
  useEffect(() => {
    if (!slot) return;
    if (isVacant(slot)) setPriceInput("0.01");
    else setPriceInput(formatMon((slot.price * 12n) / 10n));
    // 只在切换广告位时更新建议价
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId, slot?.holder]);

  const price = useMemo(() => {
    try {
      return parseEther(priceInput || "0");
    } catch {
      return 0n;
    }
  }, [priceInput]);
  const cost = slot && !isVacant(slot) ? slot.price : 0n;
  const deposit = taxPerSecond(price) * BigInt(depositSeconds);
  const total = cost + deposit;

  const connectInjected = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) {
      setMessage({
        kind: "err",
        text: "没有检测到钱包插件，请用 MetaMask / 欧易钱包的内置浏览器打开",
      });
      return;
    }
    try {
      const [account] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      try {
        await eth.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x279f" }],
        });
      } catch {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x279f",
              chainName: "Monad Testnet",
              nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
              rpcUrls: ["https://testnet-rpc.monad.xyz"],
              blockExplorerUrls: ["https://testnet.monadexplorer.com"],
            },
          ],
        });
      }
      setMode("injected");
      setAddress(account);
      setWallet(createWalletClient({ account, chain: monadTestnet, transport: custom(eth) }));
      setFundStatus("ready");
      setMessage({ kind: "ok", text: "已连接你自己的钱包" });
    } catch (e) {
      setMessage({ kind: "err", text: errorText(e) });
    }
  }, []);

  async function uploadMedia(f: File): Promise<string> {
    const r = await fetch("/api/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentType: f.type, size: f.size }),
    });
    const data = (await r.json()) as { uploadUrl?: string; publicUrl?: string; error?: string };
    if (!r.ok || !data.uploadUrl || !data.publicUrl)
      throw new Error(data.error || "拿不到上传地址");
    const put = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": f.type },
      body: f,
    });
    if (!put.ok) throw new Error(`上传失败（${put.status}）`);
    return data.publicUrl;
  }

  async function grab() {
    if (!wallet || !address || !slot || !CONTRACT_ADDRESS) return;
    setMessage(null);
    if (price < MIN_PRICE) return setMessage({ kind: "err", text: "价格最低 0.001 MON" });
    if (kind === KIND_TEXT && !text.trim())
      return setMessage({ kind: "err", text: "写点什么再抢吧" });
    if (kind !== KIND_TEXT && !file) return setMessage({ kind: "err", text: "先选一个文件" });
    if (balance < total + GAS_RESERVE) {
      return setMessage({
        kind: "err",
        text: `余额不够：需要约 ${formatMon(total + GAS_RESERVE)} MON`,
      });
    }

    localStorage.setItem(NICK_KEY, nickname);
    try {
      let content = text.trim();
      if (kind !== KIND_TEXT && file) {
        setBusy("上传中…");
        content = await uploadMedia(file);
      }
      setBusy("上链中…");
      const args = [
        BigInt(slotId),
        nickname.trim() || shortAddress(address),
        kind,
        content,
        price,
      ] as const;
      const started = performance.now();
      let hash: `0x${string}`;
      if (mode === "burner") {
        const receipt = await wallet.writeContractSync({
          address: CONTRACT_ADDRESS,
          abi: holdTheScreenAbi,
          functionName: "takeOver",
          args,
          value: total,
          account: wallet.account!,
          chain: monadTestnet,
        });
        if (receipt.status !== "success") throw new Error("交易失败（可能被别人抢先了），再试一次");
        hash = receipt.transactionHash;
      } else {
        hash = await wallet.writeContract({
          address: CONTRACT_ADDRESS,
          abi: holdTheScreenAbi,
          functionName: "takeOver",
          args,
          value: total,
          account: address,
          chain: monadTestnet,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("交易失败（可能被别人抢先了），再试一次");
      }
      const ms = Math.round(performance.now() - started);
      setMessage({
        kind: "ok",
        text: `抢到了！确认用时 ${(ms / 1000).toFixed(2)} 秒，抬头看大屏`,
        tx: hash,
      });
      setText("");
      setFile(null);
      setCooldownUntil(Date.now() + COOLDOWN_MS);
      void refresh();
    } catch (e) {
      setMessage({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const coolingDown = now < cooldownUntil;
  const canGrab = fundStatus === "ready" && !busy && !coolingDown && !!slot;

  const walletLine =
    fundStatus === "funding"
      ? "正在给你发体验币…"
      : fundStatus === "warming"
        ? "钱包准备中…"
        : fundStatus === "error"
          ? "发币失败，可以连接自己的钱包"
          : `余额 ${formatMon(balance)} MON`;

  if (!CONTRACT_ADDRESS) {
    return <main className="p-6 text-white">合约地址未配置（NEXT_PUBLIC_CONTRACT_ADDRESS）</main>;
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-zinc-950 px-4 pt-6 pb-40 text-zinc-100">
      <header className="mb-5">
        <h1 className="text-3xl font-black tracking-tight">
          霸屏 <span className="text-amber-400">Hold the Screen</span>
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          价格你自己定，按持有时间交税，谁付你的价谁就能买走。
        </p>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-zinc-900 px-3 py-2 text-sm">
          <span className="text-zinc-400">{address ? shortAddress(address) : "…"}</span>
          <span className={fundStatus === "error" ? "text-rose-400" : "text-emerald-400"}>
            {walletLine}
          </span>
        </div>
        {mode === "burner" && (
          <button
            type="button"
            onClick={connectInjected}
            className="mt-2 text-xs text-zinc-500 underline underline-offset-2"
          >
            用我自己的钱包玩（MetaMask / 欧易）
          </button>
        )}
      </header>

      <section className="mb-5 grid grid-cols-3 gap-2" aria-label="选择广告位">
        {SLOT_NAMES.map((name, i) => {
          const s = slots?.[i];
          const vacant = !s || isVacant(s);
          const active = i === slotId;
          return (
            <button
              type="button"
              key={name}
              onClick={() => setSlotId(i)}
              className={`rounded-xl border p-2 text-left text-xs ${
                active ? "border-amber-400 bg-amber-400/10" : "border-zinc-800 bg-zinc-900"
              }`}
            >
              <div className="font-bold text-zinc-100">{name}</div>
              {vacant ? (
                <div className="mt-1 text-emerald-400">空位 · 免费抢</div>
              ) : (
                <>
                  <div className="mt-1 truncate text-zinc-300">{s.nickname}</div>
                  <div className="text-amber-400">{formatMon(s.price)} MON</div>
                  <div className="text-zinc-500">剩 {s.secondsLeft.toString()} 秒</div>
                </>
              )}
            </button>
          );
        })}
      </section>

      <section className="space-y-4">
        <label className="block">
          <span className="text-sm text-zinc-400">昵称</span>
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value.slice(0, 12))}
            placeholder="大屏上显示的名字"
            className="mt-1 w-full rounded-xl bg-zinc-900 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-amber-400"
          />
        </label>

        <div>
          <span className="text-sm text-zinc-400">上屏内容</span>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {[KIND_TEXT, KIND_IMAGE, KIND_VIDEO].map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => {
                  setKind(k);
                  setFile(null);
                }}
                className={`rounded-xl py-2 text-sm font-bold ${
                  kind === k ? "bg-amber-400 text-zinc-950" : "bg-zinc-900 text-zinc-300"
                }`}
              >
                {KIND_LABELS[k]}
              </button>
            ))}
          </div>
          {kind === KIND_TEXT ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
              placeholder="想在大屏上说什么？（最多 40 字）"
              rows={2}
              className="mt-2 w-full rounded-xl bg-zinc-900 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-amber-400"
            />
          ) : (
            <label className="mt-2 flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-zinc-900 px-3 py-6 text-sm text-zinc-400">
              {file
                ? file.name
                : kind === KIND_IMAGE
                  ? "选择图片（≤ 5MB）"
                  : "选择视频（≤ 30MB，15 秒内）"}
              <input
                type="file"
                accept={kind === KIND_IMAGE ? "image/*" : "video/*"}
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm text-zinc-400">我的定价（MON）</span>
            <input
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              inputMode="decimal"
              className="mt-1 w-full rounded-xl bg-zinc-900 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-amber-400"
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">预存税金撑多久</span>
            <select
              value={depositSeconds}
              onChange={(e) => setDepositSeconds(Number(e.target.value))}
              className="mt-1 w-full rounded-xl bg-zinc-900 px-3 py-3 text-base outline-none focus:ring-2 focus:ring-amber-400"
            >
              {[30, 60, 120, 300].map((s) => (
                <option key={s} value={s}>
                  {s} 秒
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-xs leading-relaxed text-zinc-500">
          定价越高越难被抢，但每秒交的税也越多（每秒
          1%）。被别人买走时，对方付的定价和你没用完的税金都会退给你。
        </p>

        <div className="rounded-xl bg-zinc-900 px-3 py-3 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-400">付给当前霸主</span>
            <span>{formatMon(cost)} MON</span>
          </div>
          <div className="flex justify-between">
            <span className="text-zinc-400">预存税金</span>
            <span>{formatMon(deposit)} MON</span>
          </div>
          <div className="mt-1 flex justify-between border-t border-zinc-800 pt-1 font-bold">
            <span>合计</span>
            <span className="text-amber-400">{formatMon(total)} MON</span>
          </div>
        </div>
      </section>

      <div className="fixed inset-x-0 bottom-0 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent px-4 pt-6 pb-5">
        {message && (
          <output
            className={`mx-auto mb-2 block max-w-md rounded-xl px-3 py-2 text-sm ${
              message.kind === "ok"
                ? "bg-emerald-950 text-emerald-300"
                : "bg-rose-950 text-rose-300"
            }`}
          >
            {message.text}
            {message.tx && (
              <a
                href={txUrl(message.tx)}
                target="_blank"
                rel="noreferrer"
                className="ml-2 underline"
              >
                查看交易
              </a>
            )}
          </output>
        )}
        <button
          type="button"
          onClick={grab}
          disabled={!canGrab}
          className="mx-auto block w-full max-w-md rounded-2xl bg-amber-400 py-4 text-xl font-black text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {busy ?? (coolingDown ? "冷却中…" : `抢 ${SLOT_NAMES[slotId]}！`)}
        </button>
      </div>
    </main>
  );
}
