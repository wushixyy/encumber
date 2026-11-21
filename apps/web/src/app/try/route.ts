import { NextResponse } from "next/server";

// 短链接：/try 直接跳到控制台（现场分享过这个链接，保留可用）
export function GET(request: Request) {
  return NextResponse.redirect(new URL("/", request.url), 307);
}
