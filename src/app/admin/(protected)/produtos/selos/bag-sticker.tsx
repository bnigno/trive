// O adesivo da sacola: 15 × 10 cm (paisagem) que vai com a cliente para a
// rua e para casa. Duas colunas: a MARCA em destaque (monograma, letreiro,
// tagline e a frase da vitrine) e o CAMINHO DE VOLTA (QR para a Lia no
// WhatsApp, telefone, Instagram em destaque, site). Mesma linguagem do selo:
// marfim impresso com 1 mm de sangria, dourado, rosé, taupe. Modo TESOURA
// tem marcas de corte nos cantos; SILHOUETTE corta pelo DXF (cantos r 6).
// Sem imports do Next, para os testes renderizarem com react-dom/server.
import type { CSSProperties } from "react";

import { LETTERING_SYMBOL, PRINT_INK, PRINT_SANS, PRINT_SERIF } from "@/components/print/brand-lettering";
import { CropMarks } from "@/components/print/crop-marks";
import { RegistrationMarks } from "@/components/print/registration-marks";
import { BRAND } from "@/components/store/brand/assets";
import { TAGLINE_LETTERING, WORDMARK_LETTERING } from "@/components/store/brand/lettering.generated";
import { isLetteringName } from "@/components/store/brand/wordmark";
import { PAGE_A4 } from "@/core/catalog/silhouette";
import { BAG_STICKER, type GridPosition } from "@/core/print/round-labels";
import { formatPhoneBR } from "@/lib/phone";
import type { QrSvg } from "@/receipts/qr";

import type { SealMode } from "./seal";

export const BAG_QR_SYMBOL = "bag-qr";

/** O desenho, em mm, dentro da caixa de 150 × 100. */
export const BAG_ART = {
  frameInsetMm: 4,
  frameStrokeMm: 0.35,
  frameInnerInsetMm: 5,
  frameInnerStrokeMm: 0.15,
  frameRadiusMm: 4,
  brandColumnWidthMm: 76,
  dividerXMm: 78,
  monogramHeightMm: 30,
  monogramTopMm: 15,
  wordmarkWidthMm: 42,
  wordmarkTopMm: 52,
  taglineWidthMm: 24,
  taglineTopMm: 66,
  storeLineTopMm: 76,
  contactLeftMm: 82,
  contactRightMm: 142,
  qrSizeMm: 28,
  qrTopMm: 11,
  cropGapMm: 0.5,
  cropLengthMm: 2.5,
} as const;

const MONOGRAM = BRAND.light.mark[BRAND.light.mark.length - 1];
/** A frase da vitrine cabe em até 3 linhas de 60 mm sem invadir a moldura: corpo por comprimento. */
export const STORE_LINE_MAX_CHARS = 90;
const storeLineSizePt = (text: string) => (text.length <= 45 ? 10.5 : 9);
/** Nome fora do letreiro: corpo por comprimento para caber nos 76 mm da coluna. */
const storeNameSizePt = (name: string) => (name.length <= 8 ? 22 : name.length <= 14 ? 16 : 12);
const W = BAG_STICKER.widthMm;
const H = BAG_STICKER.heightMm;
const wordmarkHeightMm = (BAG_ART.wordmarkWidthMm * WORDMARK_LETTERING.height) / WORDMARK_LETTERING.width;
const taglineHeightMm = (BAG_ART.taglineWidthMm * TAGLINE_LETTERING.height) / TAGLINE_LETTERING.width;
const taglineFiletOffsetMm = ((1 - TAGLINE_LETTERING.capHeight / TAGLINE_LETTERING.height) * taglineHeightMm) / 2;
const filetLengthMm = BAG_ART.taglineWidthMm * 0.22;

export interface BagStickerData {
  storeName: string;
  /** A frase da vitrine (setting store_tagline ou o padrão da home). */
  storeLine: string;
  /** E.164 do WhatsApp da loja; null = sem QR e sem linha. */
  whatsappE164: string | null;
  /** '@usuario'. */
  instagram: string;
  /** Só o host, sem https:// ('trivemaison.com.br'). */
  siteHost: string;
  /** Nome da vendedora (setting bot_seller_name): "Fale com a Lia". */
  sellerName: string;
}

const box: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  width: `${W}mm`,
  height: `${H}mm`,
  overflow: "visible",
  color: PRINT_INK.ink,
  printColorAdjust: "exact",
  WebkitPrintColorAdjust: "exact",
};

/** Base marfim com sangria, moldura dupla e fio divisor — um SVG por adesivo. */
function BagBase({ mode }: { mode: SealMode }) {
  const b = BAG_STICKER.bleedMm;
  const r = BAG_STICKER.cornerRadiusMm;
  return (
    <svg
      aria-hidden="true"
      viewBox={`${-b} ${-b} ${W + 2 * b} ${H + 2 * b}`}
      style={{ position: "absolute", left: `${-b}mm`, top: `${-b}mm`, width: `${W + 2 * b}mm`, height: `${H + 2 * b}mm` }}
    >
      {mode === "silhouette" ? (
        <rect x={-b} y={-b} width={W + 2 * b} height={H + 2 * b} rx={r + b} ry={r + b} fill={PRINT_INK.paper} />
      ) : (
        <rect x={-b} y={-b} width={W + 2 * b} height={H + 2 * b} fill={PRINT_INK.paper} />
      )}
      <rect
        x={BAG_ART.frameInsetMm}
        y={BAG_ART.frameInsetMm}
        width={W - 2 * BAG_ART.frameInsetMm}
        height={H - 2 * BAG_ART.frameInsetMm}
        rx={BAG_ART.frameRadiusMm}
        ry={BAG_ART.frameRadiusMm}
        fill="none"
        stroke={PRINT_INK.gold}
        strokeWidth={BAG_ART.frameStrokeMm}
      />
      <rect
        x={BAG_ART.frameInnerInsetMm}
        y={BAG_ART.frameInnerInsetMm}
        width={W - 2 * BAG_ART.frameInnerInsetMm}
        height={H - 2 * BAG_ART.frameInnerInsetMm}
        rx={BAG_ART.frameRadiusMm - 1}
        ry={BAG_ART.frameRadiusMm - 1}
        fill="none"
        stroke={PRINT_INK.gold}
        strokeWidth={BAG_ART.frameInnerStrokeMm}
      />
      <line x1={BAG_ART.dividerXMm} y1={16} x2={BAG_ART.dividerXMm} y2={H - 16} stroke={PRINT_INK.gold} strokeWidth={0.15} />
    </svg>
  );
}

const eyebrow: CSSProperties = { fontFamily: PRINT_SANS, fontWeight: 500, fontSize: "6.5pt", letterSpacing: "0.22em", textTransform: "uppercase", color: PRINT_INK.taupe, lineHeight: 1.2 };
const value: CSSProperties = { fontFamily: PRINT_SANS, fontWeight: 500, fontSize: "10pt", letterSpacing: "0.02em", color: PRINT_INK.ink, lineHeight: 1.25 };

export function BagSticker({ data, mode }: { data: BagStickerData; mode: SealMode }) {
  const lettering = isLetteringName(data.storeName);
  const contactWidth = BAG_ART.contactRightMm - BAG_ART.contactLeftMm;
  return (
    <div className="seal bag-sticker" data-mode={mode} style={box}>
      <BagBase mode={mode} />
      {mode === "scissors" ? <CropMarks widthMm={W} heightMm={H} gapMm={BAG_ART.cropGapMm} lengthMm={BAG_ART.cropLengthMm} /> : null}

      {/* Coluna da marca */}
      <img
        src={MONOGRAM.src}
        alt=""
        style={{ position: "absolute", top: `${BAG_ART.monogramTopMm}mm`, left: `${BAG_ART.brandColumnWidthMm / 2}mm`, transform: "translateX(-50%)", height: `${BAG_ART.monogramHeightMm}mm`, width: "auto" }}
      />
      {lettering ? (
        <svg
          aria-label={data.storeName}
          role="img"
          viewBox={`0 0 ${WORDMARK_LETTERING.width} ${WORDMARK_LETTERING.height}`}
          fill={PRINT_INK.gold}
          style={{ position: "absolute", top: `${BAG_ART.wordmarkTopMm}mm`, left: `${BAG_ART.brandColumnWidthMm / 2}mm`, transform: "translateX(-50%)", width: `${BAG_ART.wordmarkWidthMm}mm`, height: `${wordmarkHeightMm}mm` }}
        >
          <use href={`#${LETTERING_SYMBOL.wordmark}`} />
        </svg>
      ) : (
        <div style={{ position: "absolute", top: `${BAG_ART.wordmarkTopMm - 1}mm`, left: 0, width: `${BAG_ART.brandColumnWidthMm}mm`, textAlign: "center", fontFamily: PRINT_SERIF, fontWeight: 600, fontSize: `${storeNameSizePt(data.storeName)}pt`, letterSpacing: "0.3em", paddingLeft: "0.3em", color: PRINT_INK.gold, overflowWrap: "anywhere" }}>
          {data.storeName}
        </div>
      )}
      <div lang="fr" style={{ position: "absolute", top: `${BAG_ART.taglineTopMm}mm`, left: 0, width: `${BAG_ART.brandColumnWidthMm}mm`, display: "flex", alignItems: "center", justifyContent: "center", gap: "1.8mm" }}>
        <span style={{ width: `${filetLengthMm}mm`, borderTop: `0.25mm solid ${PRINT_INK.rose}`, transform: `translateY(${taglineFiletOffsetMm}mm)` }} />
        <svg aria-label="Maison Féminine" role="img" viewBox={`0 0 ${TAGLINE_LETTERING.width} ${TAGLINE_LETTERING.height}`} fill={PRINT_INK.taupe} style={{ width: `${BAG_ART.taglineWidthMm}mm`, height: `${taglineHeightMm}mm`, display: "block" }}>
          <use href={`#${LETTERING_SYMBOL.tagline}`} />
        </svg>
        <span style={{ width: `${filetLengthMm}mm`, borderTop: `0.25mm solid ${PRINT_INK.rose}`, transform: `translateY(${taglineFiletOffsetMm}mm)` }} />
      </div>
      <p
        data-store-line=""
        style={{ position: "absolute", top: `${BAG_ART.storeLineTopMm}mm`, left: "8mm", width: `${BAG_ART.brandColumnWidthMm - 16}mm`, margin: 0, textAlign: "center", fontFamily: PRINT_SERIF, fontStyle: "italic", fontSize: `${storeLineSizePt(data.storeLine)}pt`, lineHeight: 1.3, color: PRINT_INK.taupe }}
      >
        {data.storeLine}
      </p>

      {/* Coluna de contato */}
      <div style={{ position: "absolute", top: "9mm", left: `${BAG_ART.contactLeftMm}mm`, width: `${contactWidth}mm`, height: `${H - 18}mm`, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: "4mm", alignItems: "flex-start" }}>
          {data.whatsappE164 ? (
            <svg
              role="img"
              aria-label="QR: WhatsApp da loja"
              viewBox="0 0 1 1"
              style={{ width: `${BAG_ART.qrSizeMm}mm`, height: `${BAG_ART.qrSizeMm}mm`, flex: "none", marginTop: "0.5mm" }}
            >
              <use href={`#${BAG_QR_SYMBOL}`} width={1} height={1} />
            </svg>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: "1.6mm", paddingTop: "1mm" }}>
            <p style={{ ...eyebrow, margin: 0, color: PRINT_INK.gold, fontSize: "7pt" }}>Fale com a {data.sellerName}</p>
            <p style={{ margin: 0, fontFamily: PRINT_SERIF, fontSize: "11pt", lineHeight: 1.25, color: PRINT_INK.ink }}>
              {data.whatsappE164 ? "Aponte a câmera e fale com a nossa vendedora pelo WhatsApp." : "Nossa vendedora atende pelo WhatsApp."}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "2.4mm" }}>
          {data.whatsappE164 ? (
            <div>
              <p style={{ ...eyebrow, margin: 0 }}>WhatsApp</p>
              <p data-whatsapp="" style={{ ...value, margin: 0 }}>{formatPhoneBR(data.whatsappE164)}</p>
            </div>
          ) : null}
          <div>
            <p style={{ ...eyebrow, margin: 0 }}>Instagram</p>
            <p data-instagram="" style={{ ...value, margin: 0, fontSize: "12pt", letterSpacing: "0.04em" }}>{data.instagram}</p>
          </div>
          <div>
            <p style={{ ...eyebrow, margin: 0 }}>Site · envio para todo o Brasil</p>
            <p data-site="" style={{ ...value, margin: 0 }}>{data.siteHost}</p>
          </div>
        </div>

        <p data-thanks="" style={{ margin: 0, fontFamily: PRINT_SERIF, fontStyle: "italic", fontSize: "9.5pt", color: PRINT_INK.taupe }}>
          Obrigada por levar a gente com você.
        </p>
      </div>
    </div>
  );
}

/** O símbolo do QR, uma vez por página (junto dos símbolos do letreiro). */
export function BagQrSymbol({ qr }: { qr: QrSvg }) {
  return (
    <symbol id={BAG_QR_SYMBOL} viewBox={`0 0 ${qr.size} ${qr.size}`}>
      <path d={qr.d} fill={PRINT_INK.ink} shapeRendering="crispEdges" />
    </symbol>
  );
}

const FOOTER_TOP_MM = 290;

export function BagStickerSheet({
  positions,
  data,
  mode,
  index,
  total,
}: {
  positions: readonly GridPosition[];
  data: BagStickerData;
  mode: SealMode;
  index: number;
  total: number;
}) {
  return (
    <section
      className="print-page bag-sticker-sheet w-fit shrink-0 shadow-md"
      data-mode={mode}
      data-sheet={index}
      style={{ position: "relative", boxSizing: "border-box", width: `${PAGE_A4.widthMm}mm`, height: `${PAGE_A4.heightMm}mm`, background: "#ffffff" }}
    >
      {mode === "silhouette" ? <RegistrationMarks /> : null}
      {positions.map((p) => (
        <div key={`${p.row}-${p.col}`} style={{ position: "absolute", left: `${p.xMm}mm`, top: `${p.yMm}mm` }}>
          <BagSticker data={data} mode={mode} />
        </div>
      ))}
      <div
        data-footer=""
        style={{ position: "absolute", left: 0, right: 0, top: `${FOOTER_TOP_MM}mm`, textAlign: "center", fontFamily: PRINT_SANS, fontSize: "7pt", letterSpacing: "0.06em", color: PRINT_INK.mark }}
      >
        {data.storeName} · adesivo da sacola · folha {index} de {total}
      </div>
    </section>
  );
}
