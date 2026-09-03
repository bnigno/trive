// Cabeçalho de seção da vitrine: eyebrow, título serif e a fita curta se
// desenhando (dentro de <Reveal>). `aside` recebe um link secundário ("Ver
// tudo"). Server Component.
import type { ReactNode } from "react";

import { Reveal } from "@/components/store/reveal";
import { Ribbon } from "@/components/store/ribbon";
import { eyebrow, eyebrowNoir } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";

export function SectionHeading({
  eyebrow: eyebrowText,
  title,
  id,
  aside,
  tone = "ivory",
  align = "left",
  className,
}: {
  eyebrow: string;
  title: string;
  id?: string;
  aside?: ReactNode;
  tone?: "ivory" | "noir";
  align?: "left" | "center";
  className?: string;
}) {
  const noir = tone === "noir";
  return (
    <Reveal className={cx("mb-8", className)}>
      <div
        className={cx(
          "flex flex-wrap items-end justify-between gap-4",
          align === "center" && "flex-col items-center text-center",
        )}
      >
        <div className={cx(align === "center" && "flex flex-col items-center")}>
          <p className={noir ? eyebrowNoir : eyebrow}>{eyebrowText}</p>
          <h2
            id={id}
            className={cx(
              "mt-1 font-display text-title font-semibold text-balance",
              noir ? "text-ivory-100" : "text-espresso-900",
            )}
          >
            {title}
          </h2>
          <Ribbon variant="draw" tone={tone} size="sm" className="mt-3" />
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </Reveal>
  );
}
