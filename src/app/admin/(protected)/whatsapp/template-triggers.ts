// Quando cada mensagem automática dispara, na linguagem do dono, e os dados
// de exemplo que preenchem a prévia. Só texto de UI — o gatilho real vive
// nos serviços (wa-messaging / handlers da fila).

export const TEMPLATE_TRIGGERS: Record<string, string> = {
  order_confirmed: "Quando a cliente fecha um pedido com pagamento online",
  order_confirmed_cash: "Quando a cliente fecha um pedido em dinheiro na entrega",
  payment_approved: "Quando o pagamento é aprovado",
  payment_receipt: "Junto do comprovante em imagem, quando o pagamento confirma",
  order_packed: "Junto da foto do pacote, quando você registra a embalagem",
  gift_note_preview: "Junto da imagem do bilhete, quando o pedido é presente",
  hold_reminder: "Lembrete único, 2 h antes de uma reserva gentil vencer",
  stock_back: "Uma vez, quando a peça que a cliente pediu para avisar volta ao estoque",
  order_shipped: "Quando você marca o pedido como enviado",
  order_recovery: "Um único lembrete, X minutos depois do pedido sem pagamento",
  owner_new_order: "Para você, a cada pedido novo",
  owner_payment_approved: "Para você, quando um pagamento é aprovado",
  owner_low_stock: "Para você, quando uma peça chega ao estoque mínimo",
  owner_queue_dead: "Para você, quando a fila de envios trava",
  owner_daily_digest: "Para você, todo dia às 8h, junto da imagem do resumo",
};

export const PREVIEW_VARIABLES: Record<string, string> = {
  nome: "Maria",
  cliente: "Maria da Silva",
  pedido: "#1042",
  total: "R$ 289,00",
  link: "https://www.trivemaison.com.br/pedido/…",
  prazo: "04/09/2026 às 18:00",
  rastreio: "BR123456789BR",
  metodo: "Pix",
  para: "Ana Clara",
  quantidade: "2",
  presente: "\n🎁 Presente — sem preço na embalagem",
  produto: "Vestido Dunas",
  sku: "DUNAS-PRET-M",
  disponivel: "2",
  loja: "TRIVÉ",
  dia: "quarta-feira",
  data: "09/09",
  vendas: "R$ 1.247,00",
  ticket: "R$ 311,75",
  a_pagar: "2",
  a_embalar: "1",
  a_enviar: "3",
  lia_conversas: "6",
  lia_pedidos: "2",
  lia_custo: "US$ 0,42",
};
