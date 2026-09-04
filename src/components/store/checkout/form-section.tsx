// Seção numerada do formulário de checkout (01 Seus dados, 02 Entrega,
// 03 Pagamento): numeral em ouro escuro + h2 com id para aria-labelledby.
// Sem caixa: o papel timbrado é a própria página. Sem hooks.
import type { ReactNode } from "react";

import { numeral } from "@/components/store/styles";

export function FormSection({
  id,
  number,
  title,
  children,
}: {
  /** id do h2 (a <section> usa aria-labelledby). */
  id: string;
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="border-t border-ivory-300 pt-6">
      <div className="flex items-baseline gap-3">
        <span className={numeral}>{number}</span>
        <h2
          id={id}
          className="font-display text-heading font-semibold text-espresso-900"
        >
          {title}
        </h2>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}
