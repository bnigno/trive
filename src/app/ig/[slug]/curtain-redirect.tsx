"use client";
// A cortina: ao abrir, registra o toque e leva ao WhatsApp na MESMA aba
// (location.replace — o in-app browser do Instagram e o Safari bloqueiam
// popups). Se a action falhar ou o navegador segurar a navegação, o botão
// grande continua levando à Lia (link simples, sem código).
import { useEffect, useState } from "react";

import { IconWhatsApp } from "@/components/store/icons";
import { btnGold } from "@/components/store/styles";

import { tapCampaignLinkAction } from "./actions";

/** Depois disso sem sair da página, mostramos o botão como saída manual. */
const SHOW_BUTTON_AFTER_MS = 1800;

export function CurtainRedirect({
  slug,
  sellerName,
  fallbackUrl,
}: {
  slug: string;
  sellerName: string;
  /** wa.me sem código; null = loja sem WhatsApp (o botão não aparece). */
  fallbackUrl: string | null;
}) {
  const [url, setUrl] = useState<string | null>(fallbackUrl);
  const [showButton, setShowButton] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => setShowButton(true), SHOW_BUTTON_AFTER_MS);
    (async () => {
      let target = fallbackUrl;
      try {
        const result = await tapCampaignLinkAction({ slug });
        if (result.ok) target = result.url;
      } catch {
        // O link simples segue.
      }
      if (cancelled || !target) return;
      setUrl(target);
      window.location.replace(target);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [slug, fallbackUrl]);

  if (!url) return null;
  return (
    <a
      href={url}
      className={`${btnGold} w-full max-w-xs transition-opacity duration-500 ${showButton ? "opacity-100" : "pointer-events-none opacity-0"}`}
      aria-hidden={!showButton}
      tabIndex={showButton ? 0 : -1}
    >
      <IconWhatsApp className="h-4 w-4" />
      Abrir o WhatsApp da {sellerName}
    </a>
  );
}
