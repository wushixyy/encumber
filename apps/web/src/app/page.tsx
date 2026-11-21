import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 text-center text-zinc-100">
      <h1 className="text-5xl font-black tracking-tight">
        霸屏 <span className="text-amber-400">Hold the Screen</span>
      </h1>
      <p className="mt-4 max-w-xl text-lg text-zinc-400">
        用 Harberger
        税给大屏广告位实时定价：你自己定价，按持有时间交税，任何人付你的价就能当场买走。基于 Monad
        测试网。
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/play"
          className="rounded-2xl bg-amber-400 px-6 py-3 text-lg font-black text-zinc-950"
        >
          我要抢屏
        </Link>
        <Link
          href="/screen"
          className="rounded-2xl border border-zinc-700 px-6 py-3 text-lg font-bold"
        >
          打开大屏
        </Link>
      </div>
    </main>
  );
}
