// Wordmark da maison: o nome da loja (vivo, vindo dos settings) na serif de
// display com tracking largo, sempre como texto — acessível, indexável e
// muda junto com settings.store_name. Tamanho e cor ficam por conta do caller.
import { cx } from "@/components/ui/cx";

export function Wordmark({
  children,
  className,
  weight = "semibold",
}: {
  children: React.ReactNode;
  className?: string;
  /** 600 (padrão) para header/rodapé; 400 para o hero, mais leve e alto. */
  weight?: "normal" | "semibold";
}) {
  return (
    <span
      className={cx(
        "font-display tracking-[0.3em]",
        weight === "semibold" ? "font-semibold" : "font-normal",
        className,
      )}
    >
      {children}
    </span>
  );
}
