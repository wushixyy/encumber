import { AwsClient } from "aws4fetch";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MB = 1024 * 1024;

/** 允许的文件类型 → 扩展名和大小上限 */
const ALLOWED: Record<string, { ext: string; maxBytes: number }> = {
  "image/png": { ext: "png", maxBytes: 5 * MB },
  "image/jpeg": { ext: "jpg", maxBytes: 5 * MB },
  "image/gif": { ext: "gif", maxBytes: 5 * MB },
  "image/webp": { ext: "webp", maxBytes: 5 * MB },
  "video/mp4": { ext: "mp4", maxBytes: 30 * MB },
  "video/webm": { ext: "webm", maxBytes: 30 * MB },
  "video/quicktime": { ext: "mov", maxBytes: 30 * MB },
};

const Body = z.object({
  contentType: z.string(),
  size: z.number().int().positive(),
});

/** 签发 Cloudflare R2 预签名上传地址：手机直接 PUT 到 R2，文件不经过 Vercel */
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数不正确" }, { status: 400 });
  }
  const { contentType, size } = parsed.data;
  const rule = ALLOWED[contentType];
  if (!rule) {
    return NextResponse.json(
      { error: "只支持 PNG / JPG / GIF / WebP 图片和 MP4 / WebM / MOV 视频" },
      { status: 400 },
    );
  }
  if (size > rule.maxBytes) {
    return NextResponse.json({ error: `文件太大，最多 ${rule.maxBytes / MB}MB` }, { status: 400 });
  }

  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
  const publicBase = process.env.NEXT_PUBLIC_MEDIA_BASE_URL;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !publicBase) {
    return NextResponse.json({ error: "媒体存储未配置，请先用文字" }, { status: 500 });
  }

  const key = `media/${Date.now()}-${crypto.randomUUID()}.${rule.ext}`;
  const url = new URL(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`);
  url.searchParams.set("X-Amz-Expires", "600");

  const aws = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const signed = await aws.sign(
    new Request(url, { method: "PUT", headers: { "Content-Type": contentType } }),
    { aws: { signQuery: true } },
  );

  return NextResponse.json({
    uploadUrl: signed.url,
    publicUrl: `${publicBase.replace(/\/$/, "")}/${key}`,
  });
}
