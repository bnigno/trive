"use client";
// "Falar com a Lia": o botão que leva a cliente do site ao WhatsApp já com a
// mensagem pronta e o código da ponte. O toque grava a ponte pela action e
// navega na MESMA aba (window.open depois de um await cai no bloqueador de
// popup do Safari). Se a action falhar, o link simples sem código ainda leva
// à Lia — a conversa nunca fica presa no site.
import { useState, useTransition } from "react";

import { IconWhatsApp } from "@/components/store/icons";
import { btnOutline } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";

import { startLiaBridgeAction } from "@/app/(store)/lia/actions";

export type LiaLinkProps = {
  /** O story ("campaign") tem a própria página (/ig/[slug]); aqui só o site. */
  source: "pdp" | "cart" | "footer";
  /** Nome da vendedora (setting bot_seller_name), para o rótulo. */
  sellerName: string;
  /** Link wa.me sem código, para quando a action falhar; null = loja sem WhatsApp (o botão some). */
  fallbackUrl: string | null;
  productSlug?: string;
  variantSku?: string;
  items?: readonly { variantId: string; sku: string; quantity: number }[];
  /** CEP (8 dígitos) do checkout sem frete: vai na mensagem para a Lia cotar. */
  cep?: string;
  /** "button" (marfim, contorno) ou "footer" (link claro sobre noir). */
  variant?: "button" | "footer";
  className?: string;
};

/** Teto para a action responder; depois disso a cliente vai pelo link sem código. */
const ACTION_TIMEOUT_MS = 6000;

const footerLink =
  "inline-flex min-h-11 items-center gap-2 text-sm text-ivory-200 transition-colors duration-300 hover:text-gold-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200";

export function LiaLink({
  source,
  sellerName,
  fallbackUrl,
  productSlug,
  variantSku,
  items,
  cep,
  variant = "button",
  className,
}: LiaLinkProps) {
  const [pending, startTransition] = useTransition();
  const [opening, setOpening] = useState(false);
  if (!fallbackUrl) return null;
  const label = `Falar com a ${sellerName}`;

  function open() {
    if (opening) return;
    setOpening(true);
    startTransition(async () => {
      let url = fallbackUrl as string;
      try {
        // Rede engasgada não prende a cliente em "Abrindo…": passado o teto, o link simples segue.
        const result = await Promise.race([
          startLiaBridgeAction({ source, productSlug, variantSku, items: items ? [...items] : undefined, cep: cep && /^\d{8}$/.test(cep) ? cep : undefined }),
          new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), ACTION_TIMEOUT_MS)),
        ]);
        if (result.ok) url = result.url;
      } catch {
        // O link simples segue.
      }
      window.location.assign(url);
      // Voltando pelo histórico, o botão não pode ficar travado.
      setTimeout(() => setOpening(false), 4000);
    });
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={pending || opening}
      aria-busy={pending || opening}
      className={cx(variant === "footer" ? footerLink : btnOutline, "disabled:opacity-70", className)}
    >
      <IconWhatsApp className="h-5 w-5" />
      {pending || opening ? "Abrindo o WhatsApp…" : label}
    </button>
  );
}
