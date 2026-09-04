// A folha de papel timbrado da maison (sacola, checkout, pedido): marfim
// claro, hairlines, um eyebrow como título (h2 com id para aria-labelledby)
// e, opcionalmente, o ornamento. No desktop pode ficar grudada
// (sticky) com rolagem interna — o overflow fica no próprio elemento sticky,
// nunca num ancestral, senão o Safari solta a folha. Sem hooks: pode ser
// usada por componentes cliente.
import type { ReactNode, Ref } from "react";

import { Ornament } from "@/components/store/ornament";
import { eyebrow as eyebrowClass, sheet } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";

export function Sheet({
  eyebrow,
  headingId,
  ornament = false,
  sticky = false,
  className,
  children,
  ref,
  ...rest
}: {
  /** Ref do <section> (React 19: ref é prop comum) — a sacola observa a folha. */
  ref?: Ref<HTMLElement>;
  eyebrow?: string;
  /** id do h2 (use no aria-labelledby de quem precisar). */
  headingId?: string;
  ornament?: boolean;
  sticky?: boolean;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <section
      ref={ref}
      className={cx(
        sheet,
        "px-5 py-6 sm:px-6",
        sticky &&
          "lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:max-h-[calc(100dvh-var(--header-h)-3rem)] lg:overflow-y-auto",
        className,
      )}
      {...rest}
    >
      {ornament ? <Ornament className="mb-4 text-gold-500" /> : null}
      {eyebrow ? (
        <h2 id={headingId} className={eyebrowClass}>
          {eyebrow}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

/** Divisão interna da folha: hairline em cima e um título pequeno (h3). */
export function SheetSection({
  title,
  headingId,
  className,
  children,
}: {
  title: string;
  headingId?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "mt-6 border-t border-ivory-300 pt-5 first:mt-0 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <h3 id={headingId} className={eyebrowClass}>
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}
