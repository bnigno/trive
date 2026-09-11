// Prévia do bilhete de presente em PNG (mensagem curta, longa de 280
// caracteres em 6 linhas, e sem mensagem). Sem banco e sem rede.
// Uso: npx tsx scripts/preview-gift-note.ts [pasta-de-saida]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeGiftText } from "@/core/gifts/text";
import type { GiftNoteData } from "@/core/gifts/types";
import { loadReceiptAssets } from "@/receipts/assets";
import { renderGiftNotePng } from "@/receipts/render-gift-note";

const LONG =
  "Mãe, cada vez que eu penso em elegância, penso em você.\nQue este vestido te acompanhe nos dias bonitos que ainda vêm — e que sejam muitos.\nObrigada por tudo o que você me ensinou sem dizer uma palavra.\nFeliz aniversário! Com todo o meu amor, hoje e sempre.";

async function main() {
  const out = process.argv[2] ?? ".preview";
  mkdirSync(out, { recursive: true });
  const assets = await loadReceiptAssets();
  const notes: { file: string; data: GiftNoteData }[] = [
    {
      file: "bilhete-curto.png",
      data: { recipientName: "Ana Clara", message: normalizeGiftText("Para iluminar o seu setembro. 🤎"), signature: "Com carinho, Marina", storeName: "TRIVÉ" },
    },
    {
      file: "bilhete-longo.png",
      data: { recipientName: "Mãe", message: normalizeGiftText(LONG).slice(0, 280), signature: "Com carinho, Juliana", storeName: "TRIVÉ" },
    },
    {
      file: "bilhete-sem-mensagem.png",
      data: { recipientName: "Beatriz", message: null, signature: "Com carinho, Renata", storeName: "TRIVÉ" },
    },
  ];
  for (const note of notes) {
    const started = Date.now();
    writeFileSync(join(out, note.file), await renderGiftNotePng(note.data, assets));
    console.log(`${join(out, note.file)} (${Date.now() - started} ms)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
