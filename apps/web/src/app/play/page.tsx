import type { Metadata } from "next";
import { PlayClient } from "@/components/play-client";

export const metadata: Metadata = {
  title: "霸屏 · 抢屏",
};

export default function PlayPage() {
  return <PlayClient />;
}
