// A folha A4 com os cartões da edição (9 × 12) e a carta de estreia (15 × 10)
// já desenhados (JPEGs do storage), nas posições que o núcleo decidiu. Por
// baixo de cada imagem uma base marfim 1 mm maior — a cor exata do fundo
// dos JPEGs — para o corte um pouco fora mostrar marfim, não papel branco.
// Tesoura: marcas de corte nos cantos (a linha hairline do cartão é o corte).
// Silhouette: base com cantos r 5, imagem recuada 0,3 mm num quadro que
// esconde a hairline, marcas de registro; a plotter corta pelo DXF.
// Sem imports do Next, para os testes renderizarem com react-dom/server.
import { PRINT_INK, PRINT_SANS } from "@/components/print/brand-lettering";
import { CropMarks, type CutMode } from "@/components/print/crop-marks";
import { RegistrationMarks } from "@/components/print/registration-marks";
import { PAGE_A4 } from "@/core/catalog/silhouette";
import { EDITION_PAPER } from "@/core/edition/layout";
import type { EditionSheet, PlacedEditionItem } from "@/core/print/edition-sheets";

/** No corte da plotter a imagem recua isto por lado: a linha de corte do JPEG fica sob a sangria e não aparece. */
export const SILHOUETTE_IMAGE_INSET_MM = 0.3;

const FOOTER_TOP_MM = 290;

export function PlacedImage({ item, mode }: { item: PlacedEditionItem; mode: CutMode }) {
  const b = item.bleedMm;
  const w = item.widthMm;
  const h = item.heightMm;
  const silhouette = mode === "silhouette";
  const inset = silhouette ? SILHOUETTE_IMAGE_INSET_MM : 0;
  return (
    <div data-item={item.kind} style={{ position: "absolute", left: `${item.xMm}mm`, top: `${item.yMm}mm`, width: `${w}mm`, height: `${h}mm` }}>
      <svg
        aria-hidden="true"
        viewBox={`${-b} ${-b} ${w + 2 * b} ${h + 2 * b}`}
        style={{ position: "absolute", left: `${-b}mm`, top: `${-b}mm`, width: `${w + 2 * b}mm`, height: `${h + 2 * b}mm` }}
      >
        {silhouette ? (
          <rect x={-b} y={-b} width={w + 2 * b} height={h + 2 * b} rx={item.cornerRadiusMm + b} ry={item.cornerRadiusMm + b} fill={EDITION_PAPER} />
        ) : (
          <rect x={-b} y={-b} width={w + 2 * b} height={h + 2 * b} fill={EDITION_PAPER} />
        )}
      </svg>
      <div
        style={{
          position: "absolute",
          left: `${inset}mm`,
          top: `${inset}mm`,
          width: `${w - 2 * inset}mm`,
          height: `${h - 2 * inset}mm`,
          overflow: "hidden",
          borderRadius: silhouette ? `${item.cornerRadiusMm}mm` : 0,
        }}
      >
        <img src={item.url} alt={item.alt} style={{ position: "absolute", left: `${-inset}mm`, top: `${-inset}mm`, width: `${w}mm`, height: `${h}mm`, display: "block" }} />
      </div>
      {mode === "scissors" ? <CropMarks widthMm={w} heightMm={h} /> : null}
    </div>
  );
}

export function CardSheet({
  sheet,
  mode,
  index,
  total,
  storeName,
  orderNumber,
}: {
  sheet: EditionSheet;
  mode: CutMode;
  index: number;
  total: number;
  storeName: string;
  orderNumber: number;
}) {
  return (
    <section
      className="print-page card-sheet w-fit shrink-0 shadow-md"
      data-mode={mode}
      data-sheet={index}
      data-kind={sheet.kind}
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: `${PAGE_A4.widthMm}mm`,
        height: `${PAGE_A4.heightMm}mm`,
        background: "#ffffff",
        printColorAdjust: "exact",
        WebkitPrintColorAdjust: "exact",
      }}
    >
      {mode === "silhouette" ? <RegistrationMarks /> : null}
      {sheet.items.map((item) => (
        <PlacedImage key={item.key} item={item} mode={mode} />
      ))}
      <div
        data-footer=""
        style={{ position: "absolute", left: 0, right: 0, top: `${FOOTER_TOP_MM}mm`, textAlign: "center", fontFamily: PRINT_SANS, fontSize: "7pt", letterSpacing: "0.06em", color: PRINT_INK.mark }}
      >
        {storeName} · cartões do pedido #{orderNumber} · folha {index} de {total}
      </div>
    </section>
  );
}
