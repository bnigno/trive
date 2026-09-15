// Folha A4 para a Silhouette Portrait (print & cut): 2 × 2 tags nas posições
// que o núcleo calcula dentro da área útil das marcas de registro do Studio
// — sem marcas nem linhas de corte impressas (o Studio imprime as marcas; o
// corte vem do DXF). Fundo BRANCO: esta folha vira PNG que a impressora
// imprime inteira. Na tela, um guia cinza (data-guide, fora da captura)
// mostra onde o Studio põe as marcas e a área útil. Só apresentação.
import type { ProductLabel } from "@/core/catalog/labels";
import { CUT, mirrorForBack, PAGE_A4, silhouetteSafeArea, silhouetteTagPositions, STUDIO_MARKS } from "@/core/catalog/silhouette";
import type { QrSvg } from "@/receipts/qr";

import { HangTagBack, HangTagDefs, HangTagFront, TAG } from "./hang-tag";

const POSITIONS = silhouetteTagPositions({ widthMm: TAG.widthMm, heightMm: TAG.heightMm }, PAGE_A4);
const BACK_POSITIONS = mirrorForBack(POSITIONS);
const SAFE = silhouetteSafeArea(PAGE_A4);
const GUIDE = "#c9c2b3";

/** Onde o Studio desenha as marcas e por onde a plotter corta (só guia de tela): quadrado, dois "L" de 20 mm, área útil e os contornos. */
function MarksGuide({ positions }: { positions: readonly { xMm: number; yMm: number }[] }) {
  const i = STUDIO_MARKS.insetMm;
  const b = STUDIO_MARKS.insetBottomMm;
  const w = PAGE_A4.widthMm;
  const h = PAGE_A4.heightMm;
  const len = 20;
  return (
    <svg
      data-guide=""
      aria-hidden="true"
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", inset: 0, width: `${w}mm`, height: `${h}mm`, pointerEvents: "none" }}
    >
      <rect x={i} y={i} width={5} height={5} fill={GUIDE} />
      <path d={`M${w - i - len} ${i}h${len}v${len}`} fill="none" stroke={GUIDE} strokeWidth={1} />
      <path d={`M${i} ${h - b - len}v${len}h${len}`} fill="none" stroke={GUIDE} strokeWidth={1} />
      <rect x={SAFE.xMm} y={SAFE.yMm} width={SAFE.widthMm} height={SAFE.heightMm} fill="none" stroke={GUIDE} strokeWidth={0.3} strokeDasharray="2 2" />
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
  qr,
  index,
}: {
  labels: readonly ProductLabel[];
  side: "front" | "back";
  storeName: string;
  qr: QrSvg;
  /** Número da folha (1-based): nomeia o arquivo e o botão. */
  index: number;
}) {
  const positions = side === "back" ? BACK_POSITIONS : POSITIONS;
  return (
    <section
      className="silhouette-sheet w-fit shrink-0 shadow-md"
      data-side={side}
      data-sheet={index}
      style={{ position: "relative", boxSizing: "border-box", width: `${PAGE_A4.widthMm}mm`, height: `${PAGE_A4.heightMm}mm`, background: "#ffffff", overflow: "hidden" }}
    >
      {/* Os símbolos dentro da folha: a captura em PNG clona só esta seção. */}
      <HangTagDefs qr={qr} />
      <MarksGuide positions={positions} />
      {labels.map((label, i) => {
        const position = positions[i];
        if (!position) return null;
        return (
          <div key={label.key} style={{ position: "absolute", left: `${position.xMm}mm`, top: `${position.yMm}mm` }}>
            {side === "front" ? <HangTagFront storeName={storeName} /> : <HangTagBack label={label} />}
          </div>
        );
      })}
    </section>
  );
}
