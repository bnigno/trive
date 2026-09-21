"use client";
// Guarda o código e segue na MESMA aba (replace: o link do story não vira
// uma página no histórico). Sem storage, a cliente ainda cai na peça/vitrine
// e pode digitar o código na sacola.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { writeLinkCoupon } from "@/lib/coupon-storage";

export function CouponCapture({ code, to }: { code: string; to: string }) {
  const router = useRouter();
  useEffect(() => {
    writeLinkCoupon(code);
    router.replace(to);
  }, [code, to, router]);
  return null;
}
