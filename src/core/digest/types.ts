// "Bom dia da maison": os números do dia anterior que a imagem apresenta ao
// dono. Puro: quem monta é services/daily-digest, quem desenha é
// src/receipts/render-digest. Nenhum dado de cliente entra aqui (a imagem
// vai para o WhatsApp do dono, mas circula em encaminhamentos).

export interface DailyDigestData {
  /** 'YYYY-MM-DD' do dia relatado (ontem), no calendário de São Paulo. */
  dayKey: string;
  /** "quarta-feira, 9 de setembro". */
  dayLabel: string;
  /** 0 = domingo … 6 = sábado. */
  weekdayIndex: number;
  /** Frase de abertura do dia (já sem emoji). */
  opening: string;
  sales: {
    paidOrders: number;
    revenueCents: number;
    averageTicketCents: number;
    /** Pedidos criados no dia, pagos ou não. */
    newOrders: number;
  };
  waiting: {
    pendingPayment: number;
    toPack: number;
    toShip: number;
    conversationsAwaitingOwner: number;
    /** Data marcada: precisam sair hoje (ou já atrasaram) e não saíram. */
    mustShipToday: number;
  };
  bot: {
    conversations: number;
    turns: number;
    handoffs: number;
    orders: number;
    ordersCents: number;
    costUsdCents: number;
  };
  /** Até 3 variações no limiar ou abaixo, as mais vazias primeiro. */
  lowStock: { name: string; sku: string; available: number }[];
  /** Mais vendida dos últimos 7 dias, ou null sem venda. */
  bestSeller: { name: string; quantity: number; revenueCents: number } | null;
  storeName: string;
  generatedAt: Date;
}
