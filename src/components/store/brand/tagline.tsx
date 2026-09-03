// "MAISON FÉMININE" entre dois filetes, como no logo. Texto em francês
// (lang="fr" para leitores de tela), em Jost com tracking largo.
import { STORE_TAGLINE } from "@/lib/brand";
import { cx } from "@/components/ui/cx";

export function Tagline({
  tone = "ivory",
  className,
}: {
  /** "ivory": taupe do logo claro (só sobre ivory-50/100). "noir": marfim sobre o palco. */
  tone?: "ivory" | "noir";
  className?: string;
}) {
  const noir = tone === "noir";
  return (
    <p
      lang="fr"
      className={cx(
        "inline-flex items-center gap-3 font-store text-eyebrow font-normal uppercase tracking-[0.35em]",
        noir ? "text-ivory-200" : "text-taupe-600",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cx("h-px w-8", noir ? "bg-gold-brush" : "bg-gold-500")}
      />
      {STORE_TAGLINE}
      <span
        aria-hidden="true"
        className={cx("h-px w-8", noir ? "bg-gold-brush" : "bg-gold-500")}
      />
    </p>
  );
}
