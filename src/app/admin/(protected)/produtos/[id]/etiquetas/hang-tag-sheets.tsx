// Folha A4 de tags de cabide, frente e verso: 3 × 3 tags de 55 × 90 mm com
// 5 mm de calha, grade centrada. O verso espelha as colunas — virar a folha
// na borda longa troca esquerda e direita, as linhas ficam — para frente e
// verso baterem na impressão em duplex. Só apresentação.
import { Fragment } from "react";

import type { ProductLabel } from "@/core/catalog/labels";

import { HangTagBack, HangTagFront, TAG, TAG_INK } from "./hang-tag";

export const SHEET_A4 = {
  widthMm: 210,
  heightMm: 297,
  columns: 3,
  rows: 3,
  gapMm: 5,
} as const;

const gridWidthMm = SHEET_A4.columns * TAG.widthMm + (SHEET_A4.columns - 1) * SHEET_A4.gapMm;
const gridHeightMm = SHEET_A4.rows * TAG.heightMm + (SHEET_A4.rows - 1) * SHEET_A4.gapMm;
/** Grade centrada: é o que faz o espelho do verso cair exatamente sobre a frente. */
export const SHEET_A4_MARGIN = {
  xMm: (SHEET_A4.widthMm - gridWidthMm) / 2,
  yMm: (SHEET_A4.heightMm - gridHeightMm) / 2,
} as const;

export function HangTagSheet({
  labels,
  side,
  storeName,
}: {
  labels: readonly ProductLabel[];
  side: "front" | "back";
  storeName: string;
}) {
  return (
    <section
      className={`print-page hang-tag-sheet hang-tag-sheet-${side} w-fit shrink-0 shadow-md`}
      data-side={side}
      style={{
        boxSizing: "border-box",
        width: `${SHEET_A4.widthMm}mm`,
        height: `${SHEET_A4.heightMm}mm`,
        padding: `${SHEET_A4_MARGIN.yMm}mm ${SHEET_A4_MARGIN.xMm}mm`,
        display: "grid",
        gridTemplateColumns: `repeat(${SHEET_A4.columns}, ${TAG.widthMm}mm)`,
        gridTemplateRows: `repeat(${SHEET_A4.rows}, ${TAG.heightMm}mm)`,
        columnGap: `${SHEET_A4.gapMm}mm`,
        rowGap: `${SHEET_A4.gapMm}mm`,
        background: TAG_INK.paper,
      }}
    >
      {labels.map((label, index) => {
        const row = Math.floor(index / SHEET_A4.columns) + 1;
        const col = index % SHEET_A4.columns;
        const column = side === "back" ? SHEET_A4.columns - col : col + 1;
        return (
          <div key={label.key} style={{ gridRow: row, gridColumn: column }}>
            {side === "front" ? <HangTagFront storeName={storeName} crop /> : <HangTagBack label={label} crop />}
          </div>
        );
      })}
    </section>
  );
}

/** Frente₁, verso₁, frente₂, verso₂… — a ordem que o duplex "virar na borda longa" pede. */
export function HangTagSheets({ sheets, storeName }: { sheets: readonly (readonly ProductLabel[])[]; storeName: string }) {
  return (
    <>
      {sheets.map((labels, index) => (
        <Fragment key={index}>
          <HangTagSheet labels={labels} side="front" storeName={storeName} />
          <HangTagSheet labels={labels} side="back" storeName={storeName} />
        </Fragment>
      ))}
    </>
  );
}
