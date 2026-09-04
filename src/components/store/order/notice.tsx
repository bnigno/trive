// Aviso dentro das folhas: claret (erro), gold (atenção) ou laurel (boa
// notícia), com o role certo para leitores de tela. Sem hooks.
import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";

type NoticeTone = "claret" | "gold" | "laurel";

const TONE: Record<NoticeTone, { box: string; title: string }> = {
  claret: {
    box: "border-claret-600/30 bg-claret-50 text-claret-700",
    title: "text-claret-700",
  },
  gold: {
    box: "border-gold-600/50 bg-gold-500/8 text-ink-800",
    title: "text-ink-900",
  },
  laurel: {
    box: "border-laurel-600/40 bg-ivory-50 text-ink-700",
    title: "text-laurel-700",
  },
};

export function Notice({
  tone,
  role,
  title,
  className,
  children,
}: {
  tone: NoticeTone;
  role?: "alert" | "status";
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      role={role}
      className={cx(
        "rounded-(--radius-hair) border px-4 py-3.5 font-store text-sm leading-relaxed",
        TONE[tone].box,
        className,
      )}
    >
      {title ? (
        <p className={cx("font-display text-heading font-semibold", TONE[tone].title)}>
          {title}
        </p>
      ) : null}
      {children ? <div className={cx(title ? "mt-1.5" : null)}>{children}</div> : null}
    </div>
  );
}
