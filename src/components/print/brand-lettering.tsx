// Símbolos do letreiro TRIVÉ e da tagline (paths gerados de brand-source/
// logo.svg) para as peças impressas: um <svg> escondido com <symbol>s que as
// tags e os selos usam com <use href="#tag-wordmark">. Nunca display:none —
// senão o <use> não acha o símbolo. Renderizar UMA vez por página impressa.
// Sem imports do Next, para os testes renderizarem com react-dom/server.
import { TAGLINE_LETTERING, WORDMARK_LETTERING } from "@/components/store/brand/lettering.generated";

export const LETTERING_SYMBOL = { wordmark: "tag-wordmark", tagline: "tag-tagline" } as const;

/** As tintas do lockup claro (TONES.light do pipeline da marca). */
export const PRINT_INK = {
  ink: "#201d18",
  soft: "#453f35",
  taupe: "#806c64",
  gold: "#6f561b",
  rose: "#865749",
  hole: "#b89153",
  mark: "#aba28e",
  /** O marfim do papel: na tag só na prévia; no selo, impresso. */
  paper: "#faf7f0",
} as const;

export const PRINT_SERIF = "var(--font-cormorant), 'Cormorant Garamond', Georgia, serif";
export const PRINT_SANS = "var(--font-jost), Jost, system-ui, sans-serif";

export function LetteringSymbols() {
  return (
    <>
      <symbol id={LETTERING_SYMBOL.wordmark} viewBox={WORDMARK_LETTERING.viewBox}>
        {WORDMARK_LETTERING.glyphs.map((glyph) => (
          <path key={`${glyph.x},${glyph.y}`} transform={`translate(${glyph.x} ${glyph.y})`} d={glyph.d} />
        ))}
      </symbol>
      <symbol id={LETTERING_SYMBOL.tagline} viewBox={TAGLINE_LETTERING.viewBox}>
        {TAGLINE_LETTERING.glyphs.map((glyph) => (
          <path key={`${glyph.x},${glyph.y}`} transform={`translate(${glyph.x} ${glyph.y})`} d={glyph.d} />
        ))}
      </symbol>
    </>
  );
}

/** Só o letreiro e a tagline (o selo); a tag acrescenta o QR no seu próprio defs. */
export function BrandLetteringDefs() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", overflow: "hidden" }}>
      <defs>
        <LetteringSymbols />
      </defs>
    </svg>
  );
}
