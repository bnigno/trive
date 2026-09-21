// Prazos de troca e devolução que a loja promete (Código de Defesa do
// Consumidor, arts. 26 e 49). A página /trocas-e-devolucoes e a ficha da
// loja que a Lia lê saem daqui: nunca divergem.
export const EXCHANGE_FACTS = {
  /** Arrependimento: dias corridos após receber (CDC art. 49). */
  regretDays: 7,
  /** Defeito em produto não durável (CDC art. 26). */
  defectDaysNonDurable: 30,
  /** Defeito em produto durável — roupas e acessórios (CDC art. 26). */
  defectDaysDurable: 90,
  /** Reembolso integral depois de o produto voltar, em dias úteis. */
  refundBusinessDays: 7,
  /** Resposta da equipe a um pedido de troca, em dias úteis. */
  replyBusinessDays: 2,
} as const;
