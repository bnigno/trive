// A impressão digital (dHash) de uma imagem qualquer, com o sharp — é a única
// porta de entrada: o upload da foto de produto, o backfill e a foto que a
// cliente manda no WhatsApp passam TODOS por aqui, senão os hashes não seriam
// comparáveis. Nunca lança: imagem que o sharp não abre vira null, e quem
// chama segue sem hash (o upload não pode falhar por causa disto).
import sharp from "sharp";

import { DHASH_HEIGHT, DHASH_WIDTH, dhashFromGray, phashToHex } from "@/core/images/phash";

/** Hex de 16 caracteres, ou null quando a imagem não abre. */
export async function imagePhash(data: Buffer | Uint8Array): Promise<string | null> {
  try {
    // O contrato do hash: orientação pelo EXIF, transparência sobre branco,
    // cinza, 9 × 8 esticado (fit "fill" — a proporção não importa, a
    // comparação é entre vizinhos) e os bytes crus.
    const { data: pixels } = await sharp(data, { limitInputPixels: 50_000_000 })
      .rotate()
      .flatten({ background: "#ffffff" })
      .grayscale()
      .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return phashToHex(dhashFromGray(pixels));
  } catch {
    return null;
  }
}
