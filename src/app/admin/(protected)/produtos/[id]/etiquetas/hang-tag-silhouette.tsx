// Folha A4 para a Silhouette Portrait (print & cut), impressa AQUI pelo
// navegador: 2 × 2 tags nas posições que o núcleo calcula e, na frente, as
// MARCAS DE REGISTRO no padrão do Studio (quadrado + dois "L") — a plotter
// lê as marcas impressas e corta pelo DXF. O verso não tem marcas (o corte
// lê a frente). Na tela, um guia cinza (data-guide, some no papel) mostra a
// área útil e por onde a plotter corta. Rodapé "folha n de N · frente/verso"
// na sobra inferior, para conferir se a pilha virou certo. Só apresentação.
import type { ProductLabel } from "@/core/catalog/labels";
import { RegistrationMarks } from "@/components/print/registration-marks";
import { CUT, mirrorForBack, PAGE_A4, silhouetteSafeArea, silhouetteTagPositions } from "@/core/catalog/silhouette";

import { HangTagBack, HangTagFront, SheetFooter, TAG, TAG_INK } from "./hang-tag";

const TAG_SIZE = { widthMm: TAG.widthMm, heightMm: TAG.heightMm };
const POSITIONS = silhouetteTagPositions(TAG_SIZE, PAGE_A4);
const BACK_POSITIONS = mirrorForBack(POSITIONS, TAG_SIZE, PAGE_A4);
const SAFE = silhouetteSafeArea(PAGE_A4);
const GUIDE = "#c9c2b3";
const FOOTER_Y_MM = 288;

/** Área útil e por onde a plotter corta (contornos e furos) — só guia de tela. No verso a área útil aparece refletida, como a folha virada. */
function CutGuide({ positions, side }: { positions: readonly { xMm: number; yMm: number }[]; side: "front" | "back" }) {
  const w = PAGE_A4.widthMm;
  const h = PAGE_A4.heightMm;
  const safeX = side === "back" ? w - SAFE.xMm - SAFE.widthMm : SAFE.xMm;
  return (
    <svg
      data-guide=""
      aria-hidden="true"
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", inset: 0, width: `${w}mm`, height: `${h}mm`, pointerEvents: "none" }}
    >
      <rect x={safeX} y={SAFE.yMm} width={SAFE.widthMm} height={SAFE.heightMm} fill="none" stroke={GUIDE} strokeWidth={0.3} strokeDasharray="2 2" />
      {positions.map((p) => (
        <g key={`${p.xMm}-${p.yMm}`} fill="none" stroke={GUIDE} strokeWidth={0.25}>
          <rect x={p.xMm} y={p.yMm} width={TAG.widthMm} height={TAG.heightMm} rx={CUT.cornerRadiusMm} ry={CUT.cornerRadiusMm} />
          <circle cx={p.xMm + TAG.widthMm / 2} cy={p.yMm + TAG.holeCenterYMm} r={CUT.holeDiameterMm / 2} />
        </g>
      ))}
    </svg>
  );
}

export function SilhouetteSheet({
  labels,
  side,
  storeName,
  productName,
  index,
  total,
}: {
  labels: readonly ProductLabel[];
  side: "front" | "back";
  storeName: string;
  productName: string;
  /** Número da folha (1-based) e quantas são: vai no rodapé. */
  index: number;
  total: number;
}) {
  const positions = side === "back" ? BACK_POSITIONS : POSITIONS;
  return (
    <section
      className="print-page silhouette-sheet w-fit shrink-0 shadow-md"
      data-side={side}
      data-sheet={index}
      style={{ position: "relative", boxSizing: "border-box", width: `${PAGE_A4.widthMm}mm`, height: `${PAGE_A4.heightMm}mm`, background: TAG_INK.paper }}
    >
      {side === "front" ? <RegistrationMarks /> : null}
      <CutGuide positions={positions} side={side} />
      {labels.map((label, i) => {
        const position = positions[i];
        if (!position) return null;
        return (
          <div key={label.key} style={{ position: "absolute", left: `${position.xMm}mm`, top: `${position.yMm}mm` }}>
            {side === "front" ? <HangTagFront storeName={storeName} /> : <HangTagBack label={label} />}
          </div>
        );
      })}
      <SheetFooter storeName={storeName} productName={productName} index={index} total={total} side={side} topMm={FOOTER_Y_MM} />
    </section>
  );
}
