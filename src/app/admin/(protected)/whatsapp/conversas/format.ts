import type { BadgeTone } from "@/components/ui/badge";
import type { WaMessageOrigin } from "@/core/whatsapp/origin";

/** '+5511999991234' -> '(11) •••••-1234' — nunca expõe o número inteiro. */
export function maskPhone(phoneE164: string): string {
  const last4 = phoneE164.slice(-4);
  if (phoneE164.startsWith("+55") && phoneE164.length >= 12) {
    const ddd = phoneE164.slice(3, 5);
    return `(${ddd}) •••••-${last4}`;
  }
  return `•••• ${last4}`;
}

/** '+5511999991234' -> '(11) 99999-1234' — só no painel do cliente. */
export function formatPhoneBR(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 13 || digits.length === 12)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return phoneE164;
}

/**
 * Como a conversa aparece na lista: o nome do cadastro, senão o nome do
 * perfil do WhatsApp, senão o telefone mascarado. A conversa do próprio
 * dono é "Avisos internos".
 */
export function conversationLabel(item: {
  customerName: string | null;
  displayName: string | null;
  phoneE164: string;
  isOwnerNotices: boolean;
}): string {
  if (item.isOwnerNotices) return "Avisos internos";
  return item.customerName ?? item.displayName ?? maskPhone(item.phoneE164);
}

export type AttendantBadge = {
  label: string;
  tone: BadgeTone;
  /** Quem responde a próxima mensagem: a vendedora, você ou ninguém. */
  attendant: "seller" | "you" | "nobody";
};

/**
 * Quem está atendendo a conversa agora, na linguagem do painel. 'open' com
 * bot_disabled_until no futuro é o silêncio pós-transferência: ninguém
 * automático responde até o prazo vencer ou o dono devolver à vendedora.
 * Com a vendedora desligada globalmente, uma conversa 'open' cai para
 * você também — o badge não pode dizer que ela está atendendo.
 */
export function attendantBadge(
  status: string,
  botDisabledUntil: Date | null,
  options: { botEnabled: boolean; sellerName: string },
): AttendantBadge {
  const seller = options.sellerName.trim() || "vendedora";
  if (status === "closed") {
    return { label: "Encerrada", tone: "neutral", attendant: "nobody" };
  }
  if (status === "human") {
    return { label: "Com você", tone: "warning", attendant: "you" };
  }
  if (botDisabledUntil && botDisabledUntil.getTime() > Date.now()) {
    return { label: `${seller} em pausa`, tone: "warning", attendant: "you" };
  }
  if (!options.botEnabled) {
    return { label: `${seller} desligada`, tone: "danger", attendant: "you" };
  }
  return { label: `Com a ${seller}`, tone: "success", attendant: "seller" };
}

/** Prefixo da prévia na lista: "Você:", "Lia:", "Auto:"; cliente sem prefixo. */
export function originPrefix(
  origin: WaMessageOrigin | null,
  sellerName: string,
): string | null {
  if (origin === "manual") return "Você";
  if (origin === "bot") return sellerName.trim() || "Vendedora";
  if (origin === "auto") return "Auto";
  return null;
}

/** O que a vendedora fez num turno, em português de painel. */
const TOOL_LABELS: Record<string, string> = {
  listar_produtos: "mostrou o catálogo",
  detalhar_produto: "detalhou uma peça",
  adicionar_a_sacola: "pôs na sacola",
  ver_sacola: "conferiu a sacola",
  remover_da_sacola: "tirou da sacola",
  cotar_frete: "cotou o frete",
  buscar_cadastro: "consultou o cadastro",
  criar_pedido: "criou o pedido",
  status_do_pedido: "consultou o pedido",
  enviar_chave_pix: "enviou a chave Pix",
  avisar_dono: "avisou você",
  anotar: "anotou no caderninho",
  transferir_para_atendente: "passou para você",
};

export function describeTools(tools: readonly string[]): string | null {
  const labels: string[] = [];
  for (const tool of tools) {
    const label = TOOL_LABELS[tool] ?? tool;
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return null;
  return labels.join(" · ");
}

/**
 * "Vendedora respondendo…": a última mensagem é da cliente, a vendedora
 * atende esta conversa e a mensagem tem menos de 45 s. Sem estado novo no
 * banco — é derivado do que o poll já traz.
 */
export const TYPING_WINDOW_MS = 45_000;

export function isSellerTyping(input: {
  attendant: AttendantBadge["attendant"];
  lastMessageDirection: "inbound" | "outbound" | null;
  lastMessageAt: string | null;
  now?: number;
}): boolean {
  if (input.attendant !== "seller") return false;
  if (input.lastMessageDirection !== "inbound" || !input.lastMessageAt) return false;
  const age = (input.now ?? Date.now()) - Date.parse(input.lastMessageAt);
  return age >= 0 && age < TYPING_WINDOW_MS;
}
