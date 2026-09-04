// Quando cada mensagem automática dispara, na linguagem do dono, e os dados
// de exemplo que preenchem a prévia. Só texto de UI — o gatilho real vive
// nos serviços (wa-messaging / handlers da fila).

export const TEMPLATE_TRIGGERS: Record<string, string> = {
  order_confirmed: "Quando a cliente fecha um pedido com pagamento online",
  order_confirmed_cash: "Quando a cliente fecha um pedido em dinheiro na entrega",
  payment_approved: "Quando o pagamento é aprovado",
  payment_receipt: "Junto do comprovante em imagem, quando o pagamento confirma",
  order_shipped: "Quando você marca o pedido como enviado",
  order_recovery: "Um único lembrete, X minutos depois do pedido sem pagamento",
  owner_new_order: "Para você, a cada pedido novo",
  owner_payment_approved: "Para você, quando um pagamento é aprovado",
  owner_low_stock: "Para você, quando uma peça chega ao estoque mínimo",
  owner_queue_dead: "Para você, quando a fila de envios trava",
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
  produto: "Vestido Dunas",
  sku: "DUNAS-PRET-M",
  disponivel: "2",
  loja: "TRIVÉ",
};
