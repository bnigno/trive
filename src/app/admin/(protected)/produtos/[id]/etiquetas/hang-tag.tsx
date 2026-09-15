// A tag de cabide da TRIVÉ, em milímetros reais: 55 × 90 mm, furo no topo.
// Frente = só a marca (monograma, TRIVÉ, MAISON FÉMININE entre filetes);
// verso = nome da peça, cor/tamanho, referência, composição e o QR da peça
// no site. Sem fundo impresso — o papel é o fundo (cartão creme). Só
// apresentação: os dados chegam por parâmetro. Sem imports do Next, para
// os testes renderizarem com react-dom/server.
import type { CSSProperties } from "react";

import { BRAND } from "@/components/store/brand/assets";
import { TAGLINE_LETTERING, WORDMARK_LETTERING } from "@/components/store/brand/lettering.generated";
import { isLetteringName } from "@/components/store/brand/wordmark";
import { hangTagNameSizePt, type ProductLabel } from "@/core/catalog/labels";
import type { QrSvg } from "@/receipts/qr";

/** Medidas da tag e das marcas, em mm. */
export const TAG = {
  widthMm: 55,
  heightMm: 90,
  /** Margem útil do verso: o duplex desalinha 1–2 mm, o conteúdo fica longe do corte. */
  insetMm: 5,
  holeDiameterMm: 4,
  holeCenterYMm: 7,
  /** Marcas de corte: começam a 0,5 mm do canto e medem 2 mm, fora da tag. */
  cropGapMm: 0.5,
  cropLengthMm: 2,
  /** Sangria do arquivo de gráfica (nada sangra: só pelas marcas de corte). */
  bleedMm: 3,
  monogramHeightMm: 26,
  wordmarkWidthMm: 24,
  taglineWidthMm: 17,
  qrSizeMm: 20,
} as const;

/** Tintas: as mesmas do lockup claro (TONES.light do pipeline da marca). */
export const TAG_INK = {
  ink: "#201d18",
  soft: "#453f35",
  taupe: "#806c64",
  gold: "#6f561b",
  rose: "#865749",
  hole: "#c9a088",
  mark: "#aba28e",
  /** Só na pré-visualização em tela — não imprime. */
  paper: "#faf7f0",
} as const;

export const SERIF = "var(--font-cormorant), 'Cormorant Garamond', Georgia, serif";
export const SANS = "var(--font-jost), Jost, system-ui, sans-serif";

const MONOGRAM = BRAND.light.mark[BRAND.light.mark.length - 1];

/**
 * Símbolos usados por todas as tags da página (letreiro, tagline, QR): um
 * <svg> escondido — nunca display:none, senão o <use> não acha o símbolo.
 * Renderizar UMA vez, dentro da área impressa.
 */
export function HangTagDefs({ qr }: { qr: QrSvg }) {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", overflow: "hidden" }}>
      <defs>
        <symbol id="tag-wordmark" viewBox={WORDMARK_LETTERING.viewBox}>
          {WORDMARK_LETTERING.glyphs.map((glyph) => (
            <path key={`${glyph.x},${glyph.y}`} transform={`translate(${glyph.x} ${glyph.y})`} d={glyph.d} />
          ))}
        </symbol>
        <symbol id="tag-tagline" viewBox={TAGLINE_LETTERING.viewBox}>
          {TAGLINE_LETTERING.glyphs.map((glyph) => (
            <path key={`${glyph.x},${glyph.y}`} transform={`translate(${glyph.x} ${glyph.y})`} d={glyph.d} />
          ))}
        </symbol>
        <symbol id="tag-qr" viewBox={`0 0 ${qr.size} ${qr.size}`}>
          <path d={qr.d} fill={TAG_INK.ink} shapeRendering="crispEdges" />
        </symbol>
      </defs>
    </svg>
  );
}

const tagBox: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  width: `${TAG.widthMm}mm`,
  height: `${TAG.heightMm}mm`,
  color: TAG_INK.ink,
  fontFamily: SANS,
  // Sem overflow hidden: as marcas de corte ficam FORA da tag.
};

/** Círculo do furo e, na gráfica, as marcas de corte nos cantos (fora da tag). */
export function TagMarks({ crop }: { crop: boolean }) {
  const { widthMm: w, heightMm: h, cropGapMm: g, cropLengthMm: l } = TAG;
  const corner = (x: number, y: number, sx: number, sy: number) => (
    <>
      <line x1={x + sx * g} y1={y} x2={x + sx * (g + l)} y2={y} />
      <line x1={x} y1={y + sy * g} x2={x} y2={y + sy * (g + l)} />
    </>
  );
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", inset: 0, width: `${w}mm`, height: `${h}mm`, overflow: "visible", pointerEvents: "none" }}
    >
      <circle cx={w / 2} cy={TAG.holeCenterYMm} r={TAG.holeDiameterMm / 2} fill="none" stroke={TAG_INK.hole} strokeWidth={0.2} />
      {crop ? (
        <g stroke={TAG_INK.mark} strokeWidth={0.15} strokeLinecap="butt">
          {corner(0, 0, -1, -1)}
          {corner(w, 0, 1, -1)}
          {corner(0, h, -1, 1)}
          {corner(w, h, 1, 1)}
        </g>
      ) : null}
    </svg>
  );
}

const wordmarkHeightMm = (TAG.wordmarkWidthMm * WORDMARK_LETTERING.height) / WORDMARK_LETTERING.width;
const taglineHeightMm = (TAG.taglineWidthMm * TAGLINE_LETTERING.height) / TAGLINE_LETTERING.width;
/** O filete fica no centro das maiúsculas: a caixa da tagline inclui o acento do É. */
const taglineFiletOffsetMm = ((1 - TAGLINE_LETTERING.capHeight / TAGLINE_LETTERING.height) * taglineHeightMm) / 2;
const filetLengthMm = TAG.taglineWidthMm * 0.22;

export function HangTagFront({ storeName, crop = false }: { storeName: string; crop?: boolean }) {
  const lettering = isLetteringName(storeName);
  return (
    <div className="hang-tag hang-tag-front" style={tagBox}>
      <TagMarks crop={crop} />
      <img
        src={MONOGRAM.src}
        alt=""
        style={{
          position: "absolute",
          top: "21mm",
          left: "50%",
          transform: "translateX(-50%)",
          height: `${TAG.monogramHeightMm}mm`,
          width: "auto",
        }}
      />
      {lettering ? (
        <svg
          aria-label={storeName}
          role="img"
          // O <use> de um <symbol> encaixa a viewport em (0,0) do espaço do pai:
          // o viewBox aqui começa em 0, e o do símbolo cuida do deslocamento.
          viewBox={`0 0 ${WORDMARK_LETTERING.width} ${WORDMARK_LETTERING.height}`}
          fill={TAG_INK.gold}
          style={{
            position: "absolute",
            top: "52.5mm",
            left: "50%",
            transform: "translateX(-50%)",
            width: `${TAG.wordmarkWidthMm}mm`,
            height: `${wordmarkHeightMm}mm`,
          }}
        >
          <use href="#tag-wordmark" />
        </svg>
      ) : (
        <div
          style={{
            position: "absolute",
            top: "51mm",
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: "14pt",
            letterSpacing: "0.3em",
            paddingLeft: "0.3em",
            color: TAG_INK.gold,
          }}
        >
          {storeName}
        </div>
      )}
      <div
        lang="fr"
        style={{
          position: "absolute",
          top: "64mm",
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5mm",
        }}
      >
        <span style={{ width: `${filetLengthMm}mm`, borderTop: `0.25mm solid ${TAG_INK.rose}`, transform: `translateY(${taglineFiletOffsetMm}mm)` }} />
        <svg
          aria-label="Maison Féminine"
          role="img"
          viewBox={`0 0 ${TAGLINE_LETTERING.width} ${TAGLINE_LETTERING.height}`}
          fill={TAG_INK.taupe}
          style={{ width: `${TAG.taglineWidthMm}mm`, height: `${taglineHeightMm}mm`, display: "block" }}
        >
          <use href="#tag-tagline" />
        </svg>
        <span style={{ width: `${filetLengthMm}mm`, borderTop: `0.25mm solid ${TAG_INK.rose}`, transform: `translateY(${taglineFiletOffsetMm}mm)` }} />
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function HangTagBack({ label, crop = false }: { label: ProductLabel; crop?: boolean }) {
  const nameSizePt = hangTagNameSizePt(label.productName);
  const inset = `${TAG.insetMm}mm`;
  return (
    <div className="hang-tag hang-tag-back" style={tagBox}>
      <TagMarks crop={crop} />
      <div
        style={{
          position: "absolute",
          top: "15mm",
          bottom: `${TAG.insetMm}mm`,
          left: inset,
          right: inset,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontFamily: SERIF,
            fontWeight: 600,
            fontSize: `${nameSizePt}pt`,
            lineHeight: 1.12,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            textWrap: "balance",
          }}
        >
          {label.productName}
        </div>
        <span style={{ marginTop: "2.5mm", width: "8mm", borderTop: `0.25mm solid ${TAG_INK.rose}` }} />
        {label.variantLabel ? (
          <div
            style={{
              marginTop: "2.5mm",
              fontWeight: 500,
              fontSize: "8.5pt",
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              paddingLeft: "0.18em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "100%",
            }}
          >
            {label.variantLabel}
          </div>
        ) : null}
        <div
          style={{
            marginTop: "1mm",
            fontSize: "6.5pt",
            letterSpacing: "0.08em",
            paddingLeft: "0.08em",
            color: TAG_INK.taupe,
            overflowWrap: "anywhere",
          }}
        >
          REF. {label.sku}
        </div>
        {label.composition ? (
          <div
            style={{
              marginTop: "3mm",
              fontSize: "7pt",
              lineHeight: 1.3,
              color: TAG_INK.soft,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {label.composition}
          </div>
        ) : null}
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <svg
            aria-label={`QR: ${label.productUrl}`}
            role="img"
            style={{ width: `${TAG.qrSizeMm}mm`, height: `${TAG.qrSizeMm}mm`, display: "block" }}
          >
            <use href="#tag-qr" />
          </svg>
          <div style={{ marginTop: "2.5mm", fontSize: "6.5pt", color: TAG_INK.taupe }}>veja a peça no site</div>
          <div
            style={{
              marginTop: "3.5mm",
              fontWeight: 500,
              fontSize: "6.5pt",
              letterSpacing: "0.2em",
              paddingLeft: "0.2em",
            }}
          >
            {hostOf(label.productUrl)}
          </div>
        </div>
      </div>
    </div>
  );
}
