// Wordmark da maison: o nome da loja (vivo, vindo dos settings) na serif de
// display com tracking largo. Tamanho e cor ficam por conta do caller.
import { cx } from "@/components/ui/cx";

export function Wordmark({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("font-display font-semibold tracking-[0.3em]", className)}>
      {children}
    </span>
  );
}
