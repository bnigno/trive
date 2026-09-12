// QR para embutir num desenho do Satori. A lib `qrcode` roda local, sem rede
// (mesma exceção registrada de `sharp`), e devolve PNG — o Satori aceita PNG
// em data URL sem surpresa, ao contrário de SVG embutido.
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
