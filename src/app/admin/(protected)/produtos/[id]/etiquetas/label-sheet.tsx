// A folha A4 de etiquetas em tamanho real, em milímetros: na tela é a
// pré-visualização; no papel, é o que sai. Só apresentação.
import type { ProductLabel } from "@/core/catalog/labels";
import { formatCentsBRL } from "@/lib/money";

/**
 * Grade Avery L7159 / Pimaco A4356: 3 × 8 etiquetas de 63,5 × 33,9 mm com
 * 2,5 mm entre colunas e nada entre linhas; a grade fica centralizada na
 * folha. Outra folha adesiva? Ajuste aqui e imprima uma página de teste.
 */
export const SHEET = {
  widthMm: 210,
  heightMm: 297,
  columns: 3,
  rows: 8,
  labelWidthMm: 63.5,
  labelHeightMm: 33.9,
  gapXMm: 2.5,
  gapYMm: 0,
} as const;

const gridWidthMm = SHEET.columns * SHEET.labelWidthMm + (SHEET.columns - 1) * SHEET.gapXMm;
const gridHeightMm = SHEET.rows * SHEET.labelHeightMm + (SHEET.rows - 1) * SHEET.gapYMm;
const marginXMm = (SHEET.widthMm - gridWidthMm) / 2;
const marginYMm = (SHEET.heightMm - gridHeightMm) / 2;

/** Cores fixas: a folha é branca com texto escuro mesmo no painel em modo escuro. */
const INK = "#18181b";
const INK_SOFT = "#52525b";
const CUT_LINE = "#d4d4d8";

export function LabelSheet({ labels }: { labels: ProductLabel[] }) {
  return (
    <section
      className="label-sheet bg-white"
      style={{
        width: `${SHEET.widthMm}mm`,
        height: `${SHEET.heightMm}mm`,
        boxSizing: "border-box",
        padding: `${marginYMm}mm ${marginXMm}mm`,
        display: "grid",
        gridTemplateColumns: `repeat(${SHEET.columns}, ${SHEET.labelWidthMm}mm)`,
        gridAutoRows: `${SHEET.labelHeightMm}mm`,
        columnGap: `${SHEET.gapXMm}mm`,
        rowGap: `${SHEET.gapYMm}mm`,
        alignContent: "start",
        color: INK,
      }}
    >
      {labels.map((label) => (
        <Label key={label.key} label={label} />
      ))}
    </section>
  );
}

function Label({ label }: { label: ProductLabel }) {
  return (
    <div
      className="label"
      style={{
        boxSizing: "border-box",
        height: `${SHEET.labelHeightMm}mm`,
        padding: "2.5mm 3mm",
        border: `0.2mm solid ${CUT_LINE}`,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        lineHeight: 1.2,
      }}
    >
      <div style={{ fontSize: "6.5pt", letterSpacing: "0.12em", textTransform: "uppercase", color: INK_SOFT }}>
        {label.storeName}
      </div>
      <div
        style={{
          marginTop: "1mm",
          fontSize: "10pt",
          fontWeight: 600,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {label.productName}
      </div>
      <div style={{ marginTop: "auto", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "2mm" }}>
        <div style={{ minWidth: 0 }}>
          {label.variantLabel ? (
            <div style={{ fontSize: "9pt", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {label.variantLabel}
            </div>
          ) : null}
          <div style={{ fontSize: "7pt", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: INK_SOFT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label.sku}
          </div>
        </div>
        {label.priceCents !== null ? (
          <div style={{ fontSize: "13pt", fontWeight: 700, whiteSpace: "nowrap" }}>{formatCentsBRL(label.priceCents)}</div>
        ) : null}
      </div>
    </div>
  );
}
