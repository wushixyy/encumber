import type { Metadata } from "next";
import { ScreenClient } from "@/components/screen-client";

export const metadata: Metadata = {
  title: "霸屏 · 大屏",
};

export default function ScreenPage() {
  return <ScreenClient />;
}
