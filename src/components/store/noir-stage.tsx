// Palco noir: fundo com vinheta radial (classe .noir-stage em globals.css),
// texto marfim e, opcionalmente, o grão fino (só ≥ 640px). Os momentos
// escuros da vitrine — hero, convite, rodapé — são seções com fundo explícito,
// não um dark mode.
import type { ReactNode } from "react";

import { cx } from "@/components/ui/cx";

export function NoirStage({
  as: Tag = "section",
  grain = false,
  className,
  children,
  ...rest
}: {
  as?: "section" | "div" | "footer";
  grain?: boolean;
  className?: string;
  children: ReactNode;
  id?: string;
  role?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <Tag
      className={cx(
        "noir-stage overflow-clip text-ivory-100",
        grain && "grain",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
