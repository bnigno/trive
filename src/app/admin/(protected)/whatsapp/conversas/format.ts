import type { BadgeTone } from "@/components/ui/badge";
import type { BotToolName } from "@/core/bot/tools";
import type { WaMessageOrigin } from "@/core/whatsapp/origin";

import { formatPhoneBR, maskPhone } from "@/lib/phone";

export { formatPhoneBR, maskPhone };

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
  /** Quem responde a próxima mensagem: a vendedora, você, ninguém — ou ela sugere e você envia. */
  attendant: "seller" | "you" | "nobody" | "copilot";
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
  options: { botEnabled: boolean; sellerName: string; botMode?: "autonomous" | "copilot" },
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
  if (options.botMode === "copilot") {
    return { label: `${seller} sugere · você envia`, tone: "info", attendant: "copilot" };
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
// Toda ferramenta da Lia tem rótulo: o teste em tests/app/wa-chat-format
// confere contra BOT_TOOL_NAMES, para uma ferramenta nova não aparecer crua.
export const TOOL_LABELS: Record<BotToolName, string> = {
  listar_produtos: "mostrou o catálogo",
  detalhar_produto: "detalhou uma peça",
  adicionar_a_sacola: "pôs na sacola",
  ver_sacola: "conferiu a sacola",
  remover_da_sacola: "tirou da sacola",
  validar_cupom: "validou um cupom",
  cotar_frete: "cotou o frete",
  buscar_cadastro: "consultou o cadastro",
  historico_de_compras: "viu as compras anteriores",
  criar_pedido: "criou o pedido",
  status_do_pedido: "consultou o pedido",
  confirmar_entrega: "confirmou a entrega",
  enviar_chave_pix: "enviou a chave Pix",
  avisar_dono: "avisou você",
  reservar_peca: "guardou uma peça",
  liberar_reserva: "liberou a reserva",
  avisar_quando_voltar: "anotou o aviso de volta",
  atualizar_cartela: "atualizou a cartela",
  montar_look: "montou um look",
  anotar: "anotou no caderninho",
  sugerir_tamanho: "sugeriu o tamanho",
  enviar_nota_da_curadora: "enviou o áudio da curadora",
  registrar_foto_com_a_peca: "guardou a foto dela com a peça",
  identificar_peca_na_foto: "conferiu a foto contra o catálogo",
  retirar_minha_foto: "retirou a foto dela da página",
  agendar_retorno: "combinou de chamar depois",
  transferir_para_atendente: "passou para você",
};

export function describeTools(tools: readonly string[]): string | null {
  const labels: string[] = [];
  for (const tool of tools) {
    const label = (TOOL_LABELS as Record<string, string | undefined>)[tool] ?? tool;
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
