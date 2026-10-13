// Por que o pagamento não passou, em português — e o que o dono faz a respeito.
//
// O Mercado Pago devolve o motivo em `status_detail` (cc_rejected_high_risk,
// cc_rejected_bad_filled_security_code…). Até 10/2026 esse campo era
// descartado no schema do adapter: era impossível saber pelo sistema por que
// um cartão foi recusado — só abrindo o painel do MP. Em 09–10/2026, 7 de 9
// tentativas de cartão pelo site foram recusadas e ninguém soube.
//
// Puro de propósito: é texto de regra, e se testa sozinho.

export type RejectionExplanation = {
  /** Uma frase, para a cliente ou para o dono ler sem saber inglês. */
  motivo: string;
  /** O que fazer agora. Null quando não há ação óbvia. */
  acao: string | null;
  /** Tentar o mesmo cartão de novo resolve? Muda o conselho ao dono. */
  adiantaTentarDeNovo: boolean;
};

const OFERECER_PIX = "Ofereça o Pix: aprova na hora e custa menos para a loja.";

const MOTIVOS: Record<string, RejectionExplanation> = {
  cc_rejected_high_risk: {
    motivo: "O antifraude do Mercado Pago recusou por segurança.",
    acao: OFERECER_PIX,
    adiantaTentarDeNovo: false,
  },
  cc_rejected_insufficient_amount: {
    motivo: "O cartão não tinha limite suficiente.",
    acao: "Ofereça o Pix, outro cartão ou parcelar em mais vezes.",
    adiantaTentarDeNovo: false,
  },
  cc_rejected_bad_filled_security_code: {
    motivo: "O código de segurança do cartão foi digitado errado.",
    acao: "Peça para tentar de novo conferindo os 3 dígitos do verso.",
    adiantaTentarDeNovo: true,
  },
  cc_rejected_bad_filled_date: {
    motivo: "A validade do cartão foi digitada errada.",
    acao: "Peça para tentar de novo conferindo mês e ano do cartão.",
    adiantaTentarDeNovo: true,
  },
  cc_rejected_bad_filled_other: {
    motivo: "Algum dado do cartão foi digitado errado.",
    acao: "Peça para conferir número, validade e código e tentar de novo.",
    adiantaTentarDeNovo: true,
  },
  cc_rejected_call_for_authorize: {
    motivo: "O banco pediu que a cliente autorize esta compra.",
    acao: "Peça para ela ligar para o banco e autorizar, ou ofereça o Pix.",
    adiantaTentarDeNovo: true,
  },
  cc_rejected_card_disabled: {
    motivo: "O cartão está desativado.",
    acao: "Peça para ela ativar o cartão com o banco, ou ofereça o Pix.",
    adiantaTentarDeNovo: false,
  },
  cc_rejected_duplicated_payment: {
    motivo: "Esta compra já tinha sido feita — o MP barrou a repetição.",
    acao: "Confira se o pedido já não foi pago antes de cobrar de novo.",
    adiantaTentarDeNovo: false,
  },
  cc_rejected_max_attempts: {
    motivo: "Foram tentativas demais com este cartão.",
    acao: "Peça para esperar um pouco e ofereça o Pix enquanto isso.",
    adiantaTentarDeNovo: false,
  },
  cc_rejected_other_reason: {
    motivo: "O banco emissor recusou, sem dizer o motivo.",
    acao: OFERECER_PIX,
    adiantaTentarDeNovo: false,
  },
  cc_rejected_blacklist: {
    motivo: "O cartão está em lista de bloqueio do Mercado Pago.",
    acao: OFERECER_PIX,
    adiantaTentarDeNovo: false,
  },
  cc_rejected_card_type_not_allowed: {
    motivo: "Este tipo de cartão não é aceito para esta compra.",
    acao: "Peça outro cartão ou ofereça o Pix.",
    adiantaTentarDeNovo: false,
  },
};

/** Motivo desconhecido não vira silêncio: diz o que dá para dizer. */
export function explainRejection(statusDetail: string | null): RejectionExplanation {
  if (!statusDetail) {
    return {
      motivo: "O pagamento não foi aprovado e o Mercado Pago não informou o motivo.",
      acao: OFERECER_PIX,
      adiantaTentarDeNovo: false,
    };
  }
  const conhecido = MOTIVOS[statusDetail];
  if (conhecido) return conhecido;
  return {
    // O código cru entra para o dono conseguir pesquisar ou nos contar.
    motivo: `O pagamento foi recusado (${statusDetail}).`,
    acao: OFERECER_PIX,
    adiantaTentarDeNovo: false,
  };
}
