// "Me vê com ela" — PURO: quais peças dá para vestir, que foto cada uma
// pede, os limites do dia, a legenda da prévia e o que a cliente lê quando
// algo não sai. A prévia mostra cor e modelo, nunca prova tamanho (CDC
// arts. 31/37): a legenda diz isso sempre.
import type { PieceType } from "@/core/catalog/piece-types";
import { garmentCategoryFor, type StudioGarmentCategory } from "@/core/studio/prompts";

/** Envios à FASHN por pedido: a primeira + uma repetição com outra semente se a prévia sair infiel. */
export const TRYON_MAX_ATTEMPTS = 2;

/** Padrões dos interruptores (o seed nasce com eles; o painel muda). */
export const TRYON_DEFAULTS = { perCustomerDaily: 2, dailyTotal: 20 } as const;

export const TRYON_TIMING = {
  /** Baixar a foto dela + checar a foto (visão): menos que isto, a fila devolve a linha sem contar tentativa. */
  minPrepareMs: 15_000,
  /** Menos que isto até o fim da invocação: não envia à FASHN (um envio cortado no meio seria "incerto"). */
  minSubmitMs: 20_000,
  /** Guardado do prazo para os portões e o envio pelo WhatsApp depois que a imagem chega. */
  finishReserveMs: 30_000,
  /**
   * Guardado do prazo para o envio pelo WhatsApp depois dos portões: maior que
   * o prazo do /send-image (15 s, adapters/zapi) — a função nunca morre no
   * meio de um envio que a Z-API pode ter aceitado (seria prévia em dobro).
   */
  deliverReserveMs: 20_000,
  /** O tryon-max leva ~25 s: parado há mais que isto, desiste (ela está esperando na conversa). */
  giveUpAfterMs: 8 * 60_000,
  /** Pedido "em andamento" sem mudar há tanto tempo = a fila perdeu a linha (função morta no meio): encerra. */
  staleAfterMs: 15 * 60_000,
  /** Foto mais velha que isto não vira prévia (a URL da Z-API expira e a conversa já andou). */
  photoMaxAgeMs: 24 * 3_600_000,
} as const;

/** Só roupa na 1ª versão: acessório (bolsa, brinco…) e "outro" ficam de fora. */
export function tryOnCategoryFor(pieceType: PieceType | null): StudioGarmentCategory | null {
  return garmentCategoryFor(pieceType);
}

export function isTryOnWearable(pieceType: PieceType | null): boolean {
  return tryOnCategoryFor(pieceType) !== null;
}

/**
 * O mínimo de corpo que a foto precisa mostrar. Vestido, macacão e parte de
 * baixo: até o meio das coxas (o teste de 12/10 com fotos assim saiu bom
 * para vestido curto; com vestido longo a IA completa pernas e pés — a
 * legenda de prévia cobre, e a dica pede corpo inteiro); blusa: da cintura
 * para cima basta.
 */
export type TryOnFraming = "ate_coxas" | "ate_cintura";

export function requiredFraming(category: StudioGarmentCategory): TryOnFraming {
  return category === "tops" ? "ate_cintura" : "ate_coxas";
}

export type TryOnQuotaVerdict = { ok: true } | { ok: false; reason: "limite_cliente" | "limite_loja" };

export function tryOnQuotaVerdict(input: {
  customerToday: number;
  totalToday: number;
  perCustomerDaily: number;
  dailyTotal: number;
}): TryOnQuotaVerdict {
  if (input.totalToday >= input.dailyTotal) return { ok: false, reason: "limite_loja" };
  if (input.customerToday >= input.perCustomerDaily) return { ok: false, reason: "limite_cliente" };
  return { ok: true };
}

/** A legenda que acompanha SEMPRE a prévia. */
export function tryOnCaption(productName: string): string {
  return `✨ ${productName} em você — prévia feita com IA a partir da sua foto. Mostra a cor e o modelo; o tamanho certinho a gente confere com você 💛`;
}

/** Fotos recusadas na checagem por cliente por dia (cada uma passa pela visão): este múltiplo do teto de prévias. */
export const TRYON_PHOTO_REJECTIONS_PER_PREVIEW = 3;

/** Por que a foto não serve (checagem antes de gastar). */
export const TRYON_PHOTO_PROBLEMS = [
  "sem_pessoa",
  "mais_de_uma_pessoa",
  "nao_e_foto",
  "nao_pode",
  "enquadramento",
  "parte_de_baixo",
] as const;
export type TryOnPhotoProblem = (typeof TRYON_PHOTO_PROBLEMS)[number];

/** Por que o pedido foi encerrado sem prévia (failure_reason). */
export const TRYON_FAILURE_REASONS = [
  "desligado",
  "visao_recusou",
  "foto_indisponivel",
  "peca_indisponivel",
  "recusada_pela_ia",
  "nao_ficou_fiel",
  "sem_creditos",
  "indisponivel",
  "envio_incerto",
  "demorou_demais",
] as const;
export type TryOnFailureReason = (typeof TRYON_FAILURE_REASONS)[number];

/**
 * O que a cliente lê quando a foto não serve. Nunca acusa ("parece menor",
 * "está nua"): menor de idade e nudez caem no mesmo texto neutro.
 */
export function photoProblemText(problem: TryOnPhotoProblem, input: { productName: string; framing: TryOnFraming }): string {
  switch (problem) {
    case "enquadramento":
      return input.framing === "ate_cintura"
        ? `Pra ver a ${input.productName} em você, me manda uma foto sua da cintura pra cima — em pé, de frente e com boa luz 📸`
        : `Pra ver ${input.productName} em você, preciso de uma foto sua de corpo inteiro 📸 Em pé, de frente e com boa luz — pode ser no espelho. Me manda outra?`;
    case "parte_de_baixo":
      return "Pra blusa ficar certinha na prévia, me manda uma foto em que você esteja vestida da cintura pra baixo (calça, saia ou short), em pé e com boa luz 📸";
    case "sem_pessoa":
    case "mais_de_uma_pessoa":
    case "nao_e_foto":
      return "Pra prévia eu preciso de uma foto só sua, em pé e de frente 📸 Me manda outra?";
    case "nao_pode":
      // Sem convite a outra foto: pode ser alguém que não deveria estar ali.
      return "Essa foto eu não consigo usar pra prévia 💛 Posso te mostrar a peça na modelo e conferir seu tamanho?";
  }
}

/** O que a cliente lê quando a prévia não sai por outro motivo (nunca culpa a cliente). */
export function failureText(reason: TryOnFailureReason): string {
  switch (reason) {
    case "nao_ficou_fiel":
      return "Tentei duas vezes e a prévia não ficou fiel à peça — prefiro não te mandar algo diferente do real 💛 Posso te mostrar a peça na modelo e conferir seu tamanho?";
    case "recusada_pela_ia":
      return "Essa foto eu não consigo usar pra prévia 💛 Se quiser, me manda outra só sua, vestida e de corpo inteiro.";
    case "visao_recusou":
      // Sem convite a outra foto (como no nao_pode): a recusa pode ser de quem não deveria estar ali.
      return "Não consegui fazer a prévia com essa foto 💛 Posso te mostrar a peça na modelo e conferir seu tamanho?";
    case "foto_indisponivel":
      return "Não consegui abrir a sua foto 😕 Me manda de novo?";
    case "peca_indisponivel":
      return "Essa peça acabou de sair do catálogo 😕 Quer que eu te mostre outra parecida?";
    case "desligado":
    case "sem_creditos":
    case "indisponivel":
    case "envio_incerto":
    case "demorou_demais":
      return "Não consegui fazer a sua prévia agora 😕 Mas posso te mostrar a peça na modelo e conferir seu tamanho — quer?";
  }
}

/** Limite do dia (a ferramenta da Lia usa antes de enfileirar). */
export function quotaText(reason: "limite_cliente" | "limite_loja" | "limite_fotos", perCustomerDaily: number): string {
  switch (reason) {
    case "limite_cliente":
      return `Hoje já fizemos as suas ${perCustomerDaily} prévias 💛 Amanhã tem mais! Enquanto isso, posso conferir seu tamanho?`;
    case "limite_fotos":
      return "Hoje já tentei com várias fotos suas 💛 Amanhã a gente tenta de novo! Enquanto isso, posso te mostrar a peça na modelo e conferir seu tamanho?";
    case "limite_loja":
      return "As prévias de hoje acabaram 😕 Amanhã tem mais! Enquanto isso, posso te mostrar a peça na modelo e conferir seu tamanho?";
  }
}

/** Aviso do pedido curado (parado: a fila perdeu a linha) — diz QUAL peça, para não parecer o pedido novo. */
export function staleNoticeText(productName: string): string {
  return `A prévia de ${productName} não ficou pronta a tempo 😕 Se quiser, me manda a foto de novo que eu tento outra vez.`;
}
