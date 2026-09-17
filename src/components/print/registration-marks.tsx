// As três marcas de registro do Silhouette Studio, impressas por nós na
// frente da folha (tags, selos): quadrado cheio e dois "L" como retângulos
// cheios, com a borda externa exatamente no recuo padrão. A plotter lê estas
// marcas e corta pelo DXF. Sem imports do Next (testes com react-dom/server).
import { PAGE_A4, studioRegistrationMarks, type PageMm } from "@/core/catalog/silhouette";

/**
 * As três marcas de registro, pretas, do jeito que o sensor da plotter
 * procura: quadrado cheio e dois "L" desenhados como retângulos cheios (sem
 * traço), com a borda externa exatamente no recuo e pernas de 20 mm.
 * Impressas só na frente.
 */
export function RegistrationMarks({ page = PAGE_A4 }: { page?: PageMm }) {
  const { square, topRight, bottomLeft, thicknessMm } = studioRegistrationMarks(page);
  const w = page.widthMm;
  const h = page.heightMm;
  const legs = (m: typeof topRight) => {
    const x0 = m.xDirection === 1 ? m.cornerXMm : m.cornerXMm - m.lengthMm;
    const y0 = m.yDirection === 1 ? m.cornerYMm : m.cornerYMm - m.lengthMm;
    const vx = m.xDirection === 1 ? m.cornerXMm : m.cornerXMm - thicknessMm;
    const hy = m.yDirection === 1 ? m.cornerYMm : m.cornerYMm - thicknessMm;
    return (
      <>
        <rect x={x0} y={hy} width={m.lengthMm} height={thicknessMm} fill="#000" />
        <rect x={vx} y={y0} width={thicknessMm} height={m.lengthMm} fill="#000" />
      </>
    );
  };
  return (
    <svg
      data-marks=""
      aria-hidden="true"
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", inset: 0, width: `${w}mm`, height: `${h}mm`, pointerEvents: "none" }}
    >
      <rect x={square.xMm} y={square.yMm} width={square.sizeMm} height={square.sizeMm} fill="#000" />
      {legs(topRight)}
      {legs(bottomLeft)}
    </svg>
  );
}

