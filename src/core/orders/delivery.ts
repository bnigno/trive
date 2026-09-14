// A entrega como a cliente lê — PURO. "às 17:42, recebido por Maria" na
// legenda da foto e na linha do tempo; o nome de quem recebeu é só o
// primeiro nome (a página do pedido circula em encaminhamentos).
import { spDayKey } from "@/lib/sp-day";

export const RECEIVED_BY_MAX_CHARS = 60;

/** Tratamentos e partículas que não são nome ("a própria", "Sr. João", "dona Maria"). */
const NOT_A_NAME = new Set(["a", "o", "as", "os", "sr", "sr.", "sra", "sra.", "dona", "dono", "seu", "senhor", "senhora", "de", "da", "do", "e", "própria", "propria", "próprio", "proprio"]);

/**
 * "Maria Aparecida da Silva" → "Maria"; "Sr. João" → "João"; "a própria" →
 * null; CPF/telefone (3+ dígitos) nunca vira nome — é o que vai para a
 * cliente e para a página pública.
 */
export function normalizeReceivedBy(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tokens = raw
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((token) => token.replace(/[^\p{L}\p{N}'’.-]/gu, ""))
    .filter((token) => token !== "");
  const first = tokens.find((token) => {
    if (NOT_A_NAME.has(token.toLowerCase())) return false;
    if (!/\p{L}/u.test(token)) return false;
    if ((token.match(/\p{N}/gu) ?? []).length >= 3) return false;
    return token.replace(/[^\p{L}\p{N}]/gu, "").length >= 2;
  });
  if (!first) return null;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return name.slice(0, RECEIVED_BY_MAX_CHARS);
}

const timeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

/** "hoje às 17:42" / "ontem às 17:42" / "sábado 13/09 às 17:42", relativo a `now` (relógio de SP). */
export function deliveryWhen(deliveredAt: Date, now: Date): string {
  const day = spDayKey(deliveredAt);
  const today = spDayKey(now);
  const time = timeFmt.format(deliveredAt);
  if (day === today) return `hoje às ${time}`;
  const yesterday = spDayKey(new Date(now.getTime() - 86_400_000));
  if (day === yesterday) return `ontem às ${time}`;
  const [, m, d] = day.split("-");
  return `${d}/${m} às ${time}`;
}

/** "hoje às 17:42, recebido por Maria" (sem nome: só a hora). */
export function deliveryLine(input: { deliveredAt: Date; receivedBy: string | null; now: Date }): string {
  const when = deliveryWhen(input.deliveredAt, input.now);
  return input.receivedBy ? `${when}, recebido por ${input.receivedBy}` : when;
}

/** O detalhe do passo "Entregue" na linha do tempo: "Recebido por Maria". */
export function deliveredStepDetail(receivedBy: string | null): string | null {
  return receivedBy ? `Recebido por ${receivedBy}` : null;
}
