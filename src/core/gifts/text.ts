// Limpeza do texto do bilhete: só o que a fonte da maison desenha (sem emoji
// ou símbolo — o render não pode ir à rede buscar glifo), espaços
// colapsados, no máximo 6 linhas, e o tamanho da letra pelo comprimento.
import { GIFT_MESSAGE_MAX, GIFT_MESSAGE_MAX_LINES } from "./types";

/** Letras latinas, números, pontuação, espaços e quebras de linha. */
export function normalizeGiftText(value: string): string {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}]/gu, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
  // Colapsa linhas vazias em sequência e corta no limite de linhas.
  const compact: string[] = [];
  for (const line of lines) {
    if (line === "" && (compact.length === 0 || compact[compact.length - 1] === "")) continue;
    compact.push(line);
  }
  while (compact.length > 0 && compact[compact.length - 1] === "") compact.pop();
  return compact.slice(0, GIFT_MESSAGE_MAX_LINES).join("\n").slice(0, GIFT_MESSAGE_MAX);
}

/** Nome de quem recebe: uma linha, sem emoji. */
export function normalizeGiftName(value: string): string {
  return normalizeGiftText(value).replace(/\n+/g, " ").trim();
}

/** Tamanho da letra do bilhete (px numa imagem de 1080 de largura). */
export function giftMessageFontSize(message: string): number {
  const length = message.length;
  const lines = message.split("\n").length;
  if (length <= 80 && lines <= 2) return 48;
  if (length <= 160 && lines <= 4) return 42;
  if (length <= 220) return 36;
  return 32;
}

/** "Com carinho, Maria" — primeiro nome da compradora, com a inicial maiúscula. */
export function giftSignature(buyerFullName: string): string {
  const first = buyerFullName.trim().split(/\s+/)[0] ?? "";
  const pretty = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "";
  return pretty ? `Com carinho, ${pretty}` : "Com carinho";
}
