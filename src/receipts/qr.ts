// QR para embutir num desenho do Satori (PNG) ou numa página impressa
// (path SVG, vetor). A lib `qrcode` roda local, sem rede (mesma exceção
// registrada de `sharp`).
import QRCode from "qrcode";

/** Lado do QR em pixels na imagem 1080×1440: legível a 9×12 cm impressos. */
export const QR_PNG_SIZE = 300;

export async function qrPngDataUrl(text: string, size = QR_PNG_SIZE): Promise<string> {
  const png = await QRCode.toBuffer(text, {
    type: "png",
    width: size,
    margin: 1,
    // "M" aguenta um cartão amassado na caixa e continua lendo.
    errorCorrectionLevel: "M",
    color: { dark: "#201d18", light: "#fdfbf6" },
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Versão (1–40) que o texto pede em EC "M": mais versão = mais módulos = QR mais denso. */
export function qrVersion(text: string): number {
  return QRCode.create(text, { errorCorrectionLevel: "M" }).version;
}

export interface QrSvg {
  /** Módulos por lado (a versão 4 tem 33). */
  size: number;
  /** Um `<path d>` com os módulos escuros, em unidades de módulo, para um viewBox `0 0 size size`. */
  d: string;
}

/**
 * O QR como vetor: cada corrida de módulos escuros vira um retângulo do
 * path. Quem desenha escolhe o tamanho e deixa ≥ 4 módulos de papel em volta
 * (zona de silêncio).
 */
export function qrSvgPath(text: string): QrSvg {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = modules.size;
  let d = "";
  for (let row = 0; row < size; row++) {
    let run = 0;
    for (let col = 0; col <= size; col++) {
      if (col < size && modules.get(row, col)) {
        run += 1;
        continue;
      }
      if (run > 0) {
        d += `M${col - run} ${row}h${run}v1h-${run}z`;
        run = 0;
      }
    }
  }
  return { size, d };
}
