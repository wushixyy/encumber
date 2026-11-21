import { NextResponse } from "next/server";

// 短链接：/try 自动带上演示口令跳到控制台，方便现场观众自己试（口令只在服务端环境变量里）
export function GET(request: Request) {
  const key = process.env.DEMO_KEY;
  const target = new URL("/", request.url);
  if (key) target.searchParams.set("key", key);
  return NextResponse.redirect(target, 307);
}

export const dynamic = "force-dynamic";
