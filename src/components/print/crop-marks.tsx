// Marcas de corte nos 4 cantos, FORA da peça (modo tesoura): quatro pares de
// traços finos que dizem onde passar a régua. Compartilhadas pelo adesivo da
// sacola e pelos cartões da edição. Sem imports do Next (testes com
// react-dom/server).
import { PRINT_INK } from "@/components/print/brand-lettering";

/** Como a folha vai ser cortada: tesoura/estilete pelas marcas, ou a plotter pelo DXF. */
export type CutMode = "scissors" | "silhouette";

/** Folga entre a peça e o traço, e o comprimento do traço, em mm. */
export const CROP_MARK = { gapMm: 0.5, lengthMm: 2.5 } as const;

export function CropMarks({ widthMm, heightMm, gapMm = CROP_MARK.gapMm, lengthMm = CROP_MARK.lengthMm }: { widthMm: number; heightMm: number; gapMm?: number; lengthMm?: number }) {
  const g = gapMm;
  const l = lengthMm;
  const corners: [number, number, 1 | -1, 1 | -1][] = [
    [0, 0, -1, -1],
    [widthMm, 0, 1, -1],
    [0, heightMm, -1, 1],
    [widthMm, heightMm, 1, 1],
  ];
  return (
    <svg
      data-crop-marks=""
      aria-hidden="true"
      viewBox={`${-g - l} ${-g - l} ${widthMm + 2 * (g + l)} ${heightMm + 2 * (g + l)}`}
      style={{ position: "absolute", left: `${-g - l}mm`, top: `${-g - l}mm`, width: `${widthMm + 2 * (g + l)}mm`, height: `${heightMm + 2 * (g + l)}mm`, pointerEvents: "none" }}
    >
      <g stroke={PRINT_INK.mark} strokeWidth={0.15}>
        {corners.map(([x, y, sx, sy]) => (
          <g key={`${x}-${y}`}>
            <line x1={x + sx * g} y1={y} x2={x + sx * (g + l)} y2={y} />
            <line x1={x} y1={y + sy * g} x2={x} y2={y + sy * (g + l)} />
          </g>
        ))}
      </g>
    </svg>
  );
}
