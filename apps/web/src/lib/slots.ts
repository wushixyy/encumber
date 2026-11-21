"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Address, zeroAddress } from "viem";
import { holdTheScreenAbi } from "./abi";
import { CONTRACT_ADDRESS, publicClient } from "./chain";

export const SLOT_NAMES = ["主位", "小格 1", "小格 2"] as const;
export const KIND_TEXT = 0;
export const KIND_IMAGE = 1;
export const KIND_VIDEO = 2;
export const KIND_LABELS = ["文字", "图片", "视频"] as const;

/** 和合约一致：每秒税率 1%，最低定价 0.001 MON */
const TAX_BPS_PER_SECOND = 100n;
export const MIN_PRICE = 1_000_000_000_000_000n;

export type SlotState = {
  id: number;
  holder: Address;
  kind: number;
  price: bigint;
  depositLeft: bigint;
  secondsLeft: bigint;
  lastSettled: bigint;
  nickname: string;
  content: string;
};

export const isVacant = (slot: SlotState) => slot.holder === zeroAddress;

export const taxPerSecond = (price: bigint) => (price * TAX_BPS_PER_SECOND) / 10_000n;

/** 每秒读一次所有广告位（一个 eth_call） */
export function useSlots(intervalMs = 1000) {
  const [slots, setSlots] = useState<SlotState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!CONTRACT_ADDRESS || busy.current) return;
    busy.current = true;
    try {
      const views = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: holdTheScreenAbi,
        functionName: "getSlots",
      });
      setSlots(views.map((v, id) => ({ id, ...v })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { slots, error, refresh };
}
