// CTA da sacola: link para o checkout quando a entrega está escolhida, ou o
// botão desligado com a dica. Sem hooks.
import Link from "next/link";

import { btnDisabled, btnPrimary } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";

export function CheckoutCta({
  href,
  className,
}: {
  href: string | null;
  className?: string;
}) {
  if (href) {
    return (
      <Link href={href} className={cx(btnPrimary, "w-full", className)}>
        Fechar pedido
      </Link>
    );
  }
  return (
    <div className={className}>
      <button type="button" disabled className={btnDisabled}>
        Fechar pedido
      </button>
      <p className="mt-2 text-center font-store text-xs text-ink-500">
        Calcule a entrega para continuar.
      </p>
    </div>
  );
}
