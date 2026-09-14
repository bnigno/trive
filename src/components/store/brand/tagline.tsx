// "MAISON FÉMININE" entre dois filetes rosé, como no logo: as letras são os
// <path> do próprio logo (lettering.generated.ts) pintados com a cor do texto,
// e o texto real fica só para leitores de tela (lang="fr").
import { STORE_TAGLINE } from "@/lib/brand";
import { cx } from "@/components/ui/cx";

import { TAGLINE_LETTERING } from "./lettering.generated";

export function Tagline({
  tone = "ivory",
  height = 11,
  className,
}: {
  /** "ivory": taupe do logo claro (só sobre ivory-50/100). "noir": marfim sobre o palco. */
  tone?: "ivory" | "noir";
  /** Altura do letreiro em px (inclui o acento do É; as maiúsculas têm ~80%). */
  height?: number;
  className?: string;
}) {
  const noir = tone === "noir";
  const { viewBox, width: boxWidth, height: boxHeight, glyphs } = TAGLINE_LETTERING;
  const width = Math.round((height * boxWidth) / boxHeight);
  const filet = cx("h-px w-8 shrink-0", noir ? "bg-rose-300" : "bg-rose-700");

  return (
    <p
      lang="fr"
      className={cx(
        "inline-flex items-center gap-3",
        noir ? "text-ivory-200" : "text-taupe-600",
        className,
      )}
    >
      <span aria-hidden="true" className={filet} />
      <svg
        aria-hidden="true"
        focusable="false"
        width={width}
        height={height}
        viewBox={viewBox}
        fill="currentColor"
        className="block shrink-0"
      >
        {glyphs.map((glyph) => (
          <path
            key={`${glyph.x},${glyph.y}`}
            transform={`translate(${glyph.x} ${glyph.y})`}
            d={glyph.d}
          />
        ))}
      </svg>
      <span className="sr-only">{STORE_TAGLINE}</span>
      <span aria-hidden="true" className={filet} />
    </p>
  );
}
