// O selo da embalagem: adesivo redondo de 50 mm com o logotipo (monograma +
// letreiro TRIVÉ) e o slogan embaixo, para fechar o papel que embala a
// roupa. Disco marfim (impresso — no adesivo branco é o que faz o selo
// parecer um lacre de papel creme), anel duplo dourado, e as mesmas peças da
// tag de cabide. O disco sangra 1 mm além do corte nos dois modos (o furador
// comum de scrapbook é de 2" = 50,8 mm; a tesoura erra meio milímetro):
// TESOURA acrescenta o fio-guia cinza no corte; SILHOUETTE corta pelo DXF.
// Sem imports do Next, para os testes renderizarem com react-dom/server.
import type { CSSProperties } from "react";

import { LETTERING_SYMBOL, PRINT_INK, PRINT_SANS, PRINT_SERIF } from "@/components/print/brand-lettering";
import { RegistrationMarks } from "@/components/print/registration-marks";
import { BRAND } from "@/components/store/brand/assets";
import { TAGLINE_LETTERING, WORDMARK_LETTERING } from "@/components/store/brand/lettering.generated";
import { isLetteringName } from "@/components/store/brand/wordmark";
import { PAGE_A4 } from "@/core/catalog/silhouette";
import { SEAL, type RoundLabelPosition } from "@/core/print/round-labels";

export type SealMode = "scissors" | "silhouette";

/** O desenho, em mm, dentro do quadrado de 50 × 50 (centro em 25, 25). */
export const SEAL_ART = {
  ringOuterRadiusMm: 22.8,
  ringOuterStrokeMm: 0.35,
  ringInnerRadiusMm: 22,
  ringInnerStrokeMm: 0.15,
  monogramHeightMm: 17,
  monogramTopMm: 8.5,
  wordmarkWidthMm: 21,
  wordmarkTopMm: 28,
  taglineWidthMm: 15,
  taglineTopMm: 37.5,
  /** Fio-guia de corte no modo tesoura. */
  guideStrokeMm: 0.2,
} as const;

const MONOGRAM = BRAND.light.mark[BRAND.light.mark.length - 1];
const D = SEAL.diameterMm;
const R = D / 2;
const wordmarkHeightMm = (SEAL_ART.wordmarkWidthMm * WORDMARK_LETTERING.height) / WORDMARK_LETTERING.width;
const taglineHeightMm = (SEAL_ART.taglineWidthMm * TAGLINE_LETTERING.height) / TAGLINE_LETTERING.width;
/** O filete fica no centro das maiúsculas: a caixa da tagline inclui o acento do É. */
const taglineFiletOffsetMm = ((1 - TAGLINE_LETTERING.capHeight / TAGLINE_LETTERING.height) * taglineHeightMm) / 2;
const filetLengthMm = SEAL_ART.taglineWidthMm * 0.22;

const sealBox: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  width: `${D}mm`,
  height: `${D}mm`,
  overflow: "visible",
  color: PRINT_INK.ink,
  printColorAdjust: "exact",
  WebkitPrintColorAdjust: "exact",
};

/** Disco (com sangria), anéis e (na tesoura) o fio-guia — um só SVG por selo, que extravasa a caixa de 50 mm pela sangria. */
function SealDisc({ mode }: { mode: SealMode }) {
  const bleed = SEAL.bleedMm;
  const size = D + 2 * bleed;
  return (
    <svg
      aria-hidden="true"
      viewBox={`${-bleed} ${-bleed} ${size} ${size}`}
      style={{ position: "absolute", left: `${-bleed}mm`, top: `${-bleed}mm`, width: `${size}mm`, height: `${size}mm` }}
    >
      <circle cx={R} cy={R} r={R + bleed} fill={PRINT_INK.paper} />
      <circle cx={R} cy={R} r={SEAL_ART.ringOuterRadiusMm} fill="none" stroke={PRINT_INK.gold} strokeWidth={SEAL_ART.ringOuterStrokeMm} />
      <circle cx={R} cy={R} r={SEAL_ART.ringInnerRadiusMm} fill="none" stroke={PRINT_INK.gold} strokeWidth={SEAL_ART.ringInnerStrokeMm} />
      {mode === "scissors" ? (
        <circle data-cut-guide="" cx={R} cy={R} r={R - SEAL_ART.guideStrokeMm / 2} fill="none" stroke={PRINT_INK.mark} strokeWidth={SEAL_ART.guideStrokeMm} />
      ) : null}
    </svg>
  );
}

export function Seal({ storeName, mode }: { storeName: string; mode: SealMode }) {
  const lettering = isLetteringName(storeName);
  return (
    <div className="seal" data-mode={mode} style={sealBox}>
      <SealDisc mode={mode} />
      <img
        src={MONOGRAM.src}
        alt=""
        style={{ position: "absolute", top: `${SEAL_ART.monogramTopMm}mm`, left: "50%", transform: "translateX(-50%)", height: `${SEAL_ART.monogramHeightMm}mm`, width: "auto" }}
      />
      {lettering ? (
        <svg
          aria-label={storeName}
          role="img"
          viewBox={`0 0 ${WORDMARK_LETTERING.width} ${WORDMARK_LETTERING.height}`}
          fill={PRINT_INK.gold}
          style={{ position: "absolute", top: `${SEAL_ART.wordmarkTopMm}mm`, left: "50%", transform: "translateX(-50%)", width: `${SEAL_ART.wordmarkWidthMm}mm`, height: `${wordmarkHeightMm}mm` }}
        >
          <use href={`#${LETTERING_SYMBOL.wordmark}`} />
        </svg>
      ) : (
        <div
          style={{
            position: "absolute",
            top: `${SEAL_ART.wordmarkTopMm - 1}mm`,
            left: 0,
            right: 0,
            textAlign: "center",
            fontFamily: PRINT_SERIF,
            fontWeight: 600,
            fontSize: "12pt",
            letterSpacing: "0.3em",
            paddingLeft: "0.3em",
            color: PRINT_INK.gold,
          }}
        >
          {storeName}
        </div>
      )}
      <div
        lang="fr"
        style={{ position: "absolute", top: `${SEAL_ART.taglineTopMm}mm`, left: 0, right: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: "1.3mm", fontFamily: PRINT_SANS }}
      >
        <span style={{ width: `${filetLengthMm}mm`, borderTop: `0.25mm solid ${PRINT_INK.rose}`, transform: `translateY(${taglineFiletOffsetMm}mm)` }} />
        <svg
          aria-label="Maison Féminine"
          role="img"
          viewBox={`0 0 ${TAGLINE_LETTERING.width} ${TAGLINE_LETTERING.height}`}
          fill={PRINT_INK.taupe}
          style={{ width: `${SEAL_ART.taglineWidthMm}mm`, height: `${taglineHeightMm}mm`, display: "block" }}
        >
          <use href={`#${LETTERING_SYMBOL.tagline}`} />
        </svg>
        <span style={{ width: `${filetLengthMm}mm`, borderTop: `0.25mm solid ${PRINT_INK.rose}`, transform: `translateY(${taglineFiletOffsetMm}mm)` }} />
      </div>
    </div>
  );
}

const FOOTER_TOP_MM = 290;

/** Uma folha A4 de selos: as posições vêm do núcleo; marcas de registro só no modo Silhouette. */
export function SealSheet({
  positions,
  storeName,
  mode,
  index,
  total,
}: {
  positions: readonly RoundLabelPosition[];
  storeName: string;
  mode: SealMode;
  index: number;
  total: number;
}) {
  return (
    <section
      className="print-page seal-sheet w-fit shrink-0 shadow-md"
      data-mode={mode}
      data-sheet={index}
      style={{ position: "relative", boxSizing: "border-box", width: `${PAGE_A4.widthMm}mm`, height: `${PAGE_A4.heightMm}mm`, background: "#ffffff" }}
    >
      {mode === "silhouette" ? <RegistrationMarks /> : null}
      {positions.map((p) => (
        <div key={`${p.row}-${p.col}`} style={{ position: "absolute", left: `${p.cxMm - R}mm`, top: `${p.cyMm - R}mm` }}>
          <Seal storeName={storeName} mode={mode} />
        </div>
      ))}
      <div
        data-footer=""
        style={{ position: "absolute", left: 0, right: 0, top: `${FOOTER_TOP_MM}mm`, textAlign: "center", fontFamily: PRINT_SANS, fontSize: "7pt", letterSpacing: "0.06em", color: PRINT_INK.mark }}
      >
        {storeName} · selos de embalagem · folha {index} de {total}
      </div>
    </section>
  );
}
