"use client";

// Barra fixa da sacola no celular (mesmo padrão da BuyBar da PDP): aparece
// sempre que o resumo está fora da tela — acima ou abaixo — com o total e a
// ação certa: fechar o pedido, calcular a entrega (foca o CEP) ou, quando não
// entregamos no CEP, falar no WhatsApp. `inert` quando escondida.
import Link from "next/link";

import { btnOutline, btnPrimary, eyebrow } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";

export function CartBar({
  visible,
  totalCents,
  href,
  noDelivery,
  whatsappUrl,
}: {
  visible: boolean;
  totalCents: number;
  href: string | null;
  noDelivery: boolean;
  whatsappUrl: string | null;
}) {
  function focusCep() {
    document.getElementById("cart-cep")?.focus();
  }

  return (
    <div
      inert={!visible}
      aria-hidden={!visible}
      className={cx(
        "fixed inset-x-0 bottom-0 z-30 border-t border-gold-500/40 bg-ivory-50 transition-transform duration-300 ease-silk motion-reduce:transition-none lg:hidden",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
      }}
    >
      <div className="flex items-center gap-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className={eyebrow}>Total</p>
          <p className="font-display text-xl font-semibold text-ink-900 tabular-nums">
            {formatCentsBRL(totalCents)}
          </p>
        </div>
        {href ? (
          <Link href={href} className={btnPrimary}>
            Fechar pedido
          </Link>
        ) : noDelivery && whatsappUrl ? (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={btnOutline}
          >
            Falar no WhatsApp
          </a>
        ) : (
          <button type="button" onClick={focusCep} className={btnPrimary}>
            Calcular entrega
          </button>
        )}
      </div>
    </div>
  );
}
