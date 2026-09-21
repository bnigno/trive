// Link do cupom (/c/BEMVINDA10): guarda o código no navegador e leva à peça
// (cupom de uma peça só) ou à vitrine — a sacola já aparece com o cupom
// aplicado. Código que não vale (inexistente, pausado, vencido) vai direto
// para a vitrine sem guardar nada. Nunca indexado: é um link de campanha.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { btnGold } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { resolveCouponLink } from "@/services/coupons";

import { CouponCapture } from "./coupon-capture";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Seu cupom",
  robots: { index: false, follow: false },
};

const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;

export default async function CouponLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  if (!CODE_PATTERN.test(code)) redirect("/");
  const link = await resolveCouponLink(getDb(), code);
  if (!link) redirect("/");

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <CouponCapture code={link.code} to={link.redirectTo} />
      <p className="font-store text-xs tracking-[0.16em] text-ink-500 uppercase">Seu cupom</p>
      <p className="font-display text-3xl text-ink-900">{link.code}</p>
      <p className="font-store text-sm text-ink-700">Guardamos o cupom para você: ele aparece aplicado na sacola.</p>
      <noscript>
        <Link href={link.redirectTo} className={btnGold}>
          Continuar
        </Link>
      </noscript>
    </main>
  );
}
