// Fontes e lockup do comprovante, embutidos em base64 por
// scripts/generate-receipt-assets.mjs. Decodificação preguiçosa e memoizada:
// nada acontece ao importar o módulo (quem importa os handlers da fila não
// paga nada), e nada é lido do disco em produção — o build da Vercel
// (Turbopack) não garante arquivos soltos dentro da função.
import type { ReceiptAssets } from "@/core/receipts/types";

import { RECEIPT_ASSETS_B64 } from "./assets.generated";

let assetsPromise: Promise<ReceiptAssets> | null = null;

function decode(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

export function loadReceiptAssets(): Promise<ReceiptAssets> {
  assetsPromise ??= Promise.resolve({
    fonts: [
      { name: "Cormorant Garamond", data: decode(RECEIPT_ASSETS_B64.cormorantSemiBold), weight: 600, style: "normal" },
      { name: "Cormorant Garamond", data: decode(RECEIPT_ASSETS_B64.cormorantItalic), weight: 400, style: "italic" },
      { name: "Jost", data: decode(RECEIPT_ASSETS_B64.jostRegular), weight: 400, style: "normal" },
      { name: "Jost", data: decode(RECEIPT_ASSETS_B64.jostMedium), weight: 500, style: "normal" },
    ],
    lockupDarkPng: decode(RECEIPT_ASSETS_B64.lockupDarkPng),
  });
  return assetsPromise;
}
