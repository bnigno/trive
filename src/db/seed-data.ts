// Dados iniciais do seed — arrays PUROS, sem efeito colateral ao importar:
// o seed (src/db/seed.ts) e o scripts/sync-seed.ts (produção) leem daqui.
// Chaves de settings e templates são FIXAS: o painel só edita valores/textos.

export type SeedSetting = { key: string; value: unknown };
export type SeedWaTemplate = { key: string; label: string; bodyTemplate: string; variables: string[] };

export const initialSettings: Array<{ key: string; value: unknown }> = [
  { key: "approval_price_change_pct", value: 0.1 },
  { key: "approval_below_min_margin", value: true },
  { key: "stock_reservation_ttl_minutes", value: 120 },
  { key: "owner_whatsapp_phone", value: null },
  // Fase 1
  { key: "price_change_pct_threshold", value: 0.1 },
  { key: "first_price_requires_approval", value: true },
  { key: "default_low_stock_threshold", value: 3 },
  // Fase 2 — dados da loja. PREENCHER em /admin/configuracoes: identificação
  // do fornecedor (nome, CNPJ, endereço e contato) no rodapé da loja é
  // obrigatória por lei no e-commerce (Decreto 7.962/2013, art. 2º).
  { key: "store_name", value: "TRIVÉ" },
  { key: "store_cnpj", value: "" },
  { key: "store_address", value: "" },
  { key: "store_email", value: "" },
  { key: "store_whatsapp", value: "" },
  // Fase 4 — WhatsApp (Z-API). wa_enabled fica false até o dono conectar a
  // sessão; recuperação de pedido não pago dispara após N minutos (UMA vez).
  { key: "wa_enabled", value: false },
  { key: "wa_recovery_after_minutes", value: 60 },
  // Fase 5 — Bot de vendas com IA. Desligado até o dono ativar no admin.
  { key: "bot_enabled", value: false },
  { key: "bot_model", value: "claude-sonnet-5" },
  { key: "bot_extra_instructions", value: "" },
  // Fase 6 — chave Pix da LOJA para Pix manual (plano B do robô).
  // Vazia = recurso desligado; o dono cadastra em /admin/configuracoes.
  { key: "store_pix_key", value: "" },
  { key: "owner_digest_enabled", value: true },
  { key: "bot_media_enabled", value: true },
  { key: "bot_cards_enabled", value: true },
  { key: "wa_send_window_start", value: 9 },
  { key: "wa_send_window_end", value: 21 },
  { key: "wa_bulk_interval_seconds", value: 20 },
  { key: "hold_ttl_hours", value: 24 },
  // Onda 5 — transferência: silêncio da vendedora e volta automática.
  { key: "handoff_silence_hours", value: 24 },
  { key: "handoff_auto_return_hours", value: 12 },
  { key: "drop_audience_limit", value: 60 },
  { key: "catalog_draft_enabled", value: true },
  { key: "edition_name", value: "" },
  // Datas da cidade (Círio, Natal…): a dona cadastra em Configurações.
  { key: "city_dates", value: [] },
  // A carta de estreia fica desligada até a dona escrevê-la em Configurações.
  { key: "debut_letter_text", value: "" },
  { key: "debut_letter_signature", value: "" },
];

// Templates iniciais de WhatsApp (pt-BR). Editáveis em /admin; o seed nunca
// sobrescreve edições (onConflictDoNothing por key). Mensagens transacionais
// ao CLIENTE terminam com a instrução SAIR (opt-out LGPD); as [interno] vão
// só para o dono e dispensam isso.
export const initialWaTemplates: Array<{
  key: string;
  label: string;
  bodyTemplate: string;
  variables: string[];
}> = [
  {
    key: "order_confirmed",
    label: "Pedido recebido",
    bodyTemplate:
      "Oi, {{nome}}! Recebemos seu pedido #{{pedido}} no valor de {{total}}. 💛\n" +
      "Sua reserva fica garantida até {{prazo}} — é só concluir o pagamento.\n" +
      "Acompanhe por aqui: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "total", "link", "prazo"],
  },
  {
    // Pedido em dinheiro na entrega: SEM link de pagamento e SEM prazo de
    // reserva ({{link}} aqui é o de ACOMPANHAMENTO do pedido).
    key: "order_confirmed_cash",
    label: "Pedido recebido (dinheiro na entrega)",
    bodyTemplate:
      "Oi, {{nome}}! Recebemos seu pedido #{{pedido}} no valor de {{total}}. 💛\n" +
      "O pagamento é em dinheiro na entrega — vamos combinar os detalhes por aqui no WhatsApp.\n" +
      "Acompanhe seu pedido: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "total", "link"],
  },
  {
    key: "payment_approved",
    label: "Pagamento aprovado",
    bodyTemplate:
      "{{nome}}, seu pagamento do pedido #{{pedido}} foi aprovado! 🎉\n" +
      "Já estamos preparando tudo com carinho. Acompanhe: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "link"],
  },
  {
    // Comprovante de pagamento em imagem (legenda da foto): sai depois do
    // payment_approved, só com opt-in, e sempre com a saída (SAIR).
    key: "payment_receipt",
    label: "Comprovante de pagamento (legenda da imagem)",
    bodyTemplate:
      "{{nome}}, este é o comprovante do pagamento do pedido #{{pedido}}. A maison agradece. 🤍\n" +
      "Acompanhe: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "link"],
  },
  {
    // Foto do pacote (legenda da imagem): sai quando o dono registra a
    // embalagem com foto; só com opt-in; uma vez por pedido.
    key: "order_packed",
    label: "Peça embalada (legenda da foto)",
    bodyTemplate:
      "{{nome}}, sua peça foi embalada com carinho 🤎\n" +
      "O pedido #{{pedido}} já está pronto para seguir viagem — em breve mandamos o rastreio.\n" +
      "Acompanhe: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "link"],
  },
  {
    // Cancelamento (pela dona ou por expiração da reserva): motivo em
    // linguagem humana (friendlyCancelReason); só com opt-in; uma vez.
    key: "order_canceled",
    label: "Pedido cancelado",
    bodyTemplate:
      "{{nome}}, o pedido #{{pedido}} foi cancelado: {{motivo}}.\n" +
      "Se quiser a peça de novo, é só chamar por aqui que a gente refaz 🤎\n" +
      "Detalhes: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "motivo", "link"],
  },
  {
    // Reembolso confirmado pelo Mercado Pago; só com opt-in; uma vez.
    key: "order_refunded",
    label: "Reembolso confirmado",
    bodyTemplate:
      "{{nome}}, o reembolso de {{total}} do pedido #{{pedido}} foi confirmado.\n" +
      "O valor volta pelo mesmo meio de pagamento, no prazo do banco ou do cartão.\n" +
      "Detalhes: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "total", "link"],
  },
  {
    key: "order_shipped",
    label: "Pedido enviado",
    bodyTemplate:
      "Boa notícia, {{nome}}! Seu pedido #{{pedido}} está a caminho. 📦\n" +
      "Código de rastreio: {{rastreio}}\n" +
      "Acompanhe por aqui: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "rastreio", "link"],
  },
  {
    key: "order_out_for_delivery",
    label: "Saiu para entrega (motoboy)",
    bodyTemplate:
      "Boa notícia, {{nome}}! Seu pedido #{{pedido}} saiu da maison e chega {{dia}}, entre {{janela}}. 🛵\n" +
      "Acompanhe por aqui: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "dia", "janela", "link"],
  },
  {
    key: "order_recovery",
    label: "Lembrete de pagamento",
    bodyTemplate:
      "Oi, {{nome}}! Vimos que o pagamento do pedido #{{pedido}} ({{total}}) ainda não foi concluído — sua reserva vale até {{prazo}}.\n" +
      "Se quiser finalizar, é por aqui: {{link}}\n" +
      "Este é o único lembrete que enviaremos, prometido. 😊\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "total", "link", "prazo"],
  },
  {
    key: "owner_new_order",
    label: "[interno] Novo pedido",
    bodyTemplate:
      "Novo pedido na loja! 🛍️\n" +
      "Pedido #{{pedido}} — {{total}}\n" +
      "Cliente: {{cliente}}{{presente}}",
    variables: ["pedido", "total", "cliente", "presente"],
  },
  {
    // Bilhete do presente (legenda da imagem): sai quando o pedido é
    // presente, junto da prévia do bilhete; só com opt-in; uma vez por pedido.
    key: "gift_note_preview",
    label: "Bilhete do presente (legenda da imagem)",
    bodyTemplate:
      "{{nome}}, o bilhete para {{para}} ficou assim 🎁\n" +
      "Ele vai impresso dentro do pacote — e a embalagem segue sem preço.\n" +
      "Quer ajustar alguma palavra? É só responder por aqui.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "para"],
  },
  {
    key: "owner_payment_approved",
    label: "[interno] Pagamento aprovado",
    bodyTemplate:
      "Pagamento aprovado! 💰\n" +
      "Pedido #{{pedido}} — {{total}}\n" +
      "Forma de pagamento: {{metodo}}",
    variables: ["pedido", "total", "metodo"],
  },
  {
    // Chargeback sinalizado pelo MP: sem transição automática — o dono decide.
    key: "owner_chargeback",
    label: "[interno] Chargeback",
    bodyTemplate:
      "Chargeback no pedido #{{pedido}} ⚠️\n" +
      "Cliente: {{cliente}} · {{total}}\n" +
      "O Mercado Pago contestou o pagamento. Confira no painel e responda à contestação no MP.",
    variables: ["pedido", "cliente", "total"],
  },
  {
    // Taxa real do MP diferente da estimada na precificação.
    key: "owner_fee_divergent",
    label: "[interno] Taxa do MP diferente da estimada",
    bodyTemplate:
      "Taxa do Mercado Pago diferente no pedido #{{pedido}} ({{metodo}}).\n" +
      "Estimada: {{estimada}} · Real: {{real}} · Diferença: {{diferenca}}\n" +
      "Confira as regras de taxa em Configurações.",
    variables: ["pedido", "metodo", "estimada", "real", "diferenca"],
  },
  {
    key: "owner_low_stock",
    label: "[interno] Estoque baixo",
    bodyTemplate:
      "Atenção: estoque baixo. ⚠️\n" +
      "{{produto}} (SKU {{sku}})\n" +
      "Disponível: {{disponivel}}",
    variables: ["produto", "sku", "disponivel"],
  },
  {
    // Reserva gentil: lembrete único 2 h antes de vencer; só com opt-in.
    key: "hold_reminder",
    label: "Reserva gentil (lembrete)",
    bodyTemplate:
      "{{nome}}, a {{produto}} continua guardada para você até {{prazo}} 🤎\n" +
      "Quer fechar? Responda por aqui ou veja a peça: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "produto", "prazo", "link"],
  },
  {
    // "Me avisa quando voltar": UMA mensagem quando a peça volta ao estoque.
    key: "stock_back",
    label: "Peça voltou (aviso pedido)",
    bodyTemplate:
      "{{nome}}, voltou! {{produto}} está de novo em estoque — e tem só {{quantidade}}.\n" +
      "Veja por aqui: {{link}}\n" +
      "Você pediu este aviso e ele é único. Para não receber outros, responda SAIR.",
    variables: ["nome", "produto", "quantidade", "link"],
  },
  {
    // Convite VIP de lançamento: UMA mensagem por cliente, só com opt-in,
    // dentro da janela de envio, algumas horas antes da peça abrir para todas.
    key: "drop_vip_invite",
    label: "Convite VIP de lançamento",
    bodyTemplate:
      "{{nome}}, você vê primeiro 🤍\n" +
      "{{lancamento}} abre para todo mundo em {{prazo}} — e as peças ({{pecas}}) já estão liberadas para você por aqui: {{link}}\n" +
      "Quer que a Lia separe alguma por 24 h? É só responder.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "lancamento", "pecas", "prazo", "link"],
  },
  {
    // Lista de espera da estreia (/estreia): quem pediu aviso recebe UMA
    // mensagem quando a cortina abre, dentro da janela de envio.
    key: "drop_open",
    label: "A cortina abriu (lista de espera da estreia)",
    bodyTemplate:
      "{{nome}}, a cortina abriu ✨\n" +
      "{{lancamento}} está no ar: {{pecas}}. Veja tudo aqui: {{link}}\n" +
      "Quer que eu guarde alguma por 24 h? É só me responder.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "lancamento", "pecas", "link"],
  },
  {
    key: "owner_queue_dead",
    label: "[interno] Fila com problemas",
    bodyTemplate:
      "Atenção: {{quantidade}} evento(s) na fila esgotaram as tentativas. ⚠️\n" +
      "Confira em /admin/fila.",
    variables: ["quantidade"],
  },
  {
    // Legenda da imagem "Bom dia da maison" (todo dia às 8h, só para o dono).
    key: "owner_daily_digest",
    label: "[interno] Bom dia da maison (legenda da imagem)",
    bodyTemplate:
      "Bom dia! ☕ Seu resumo de {{dia}}, {{data}}:\n" +
      "Vendas: {{vendas}} em {{pedidos}} pedido(s) · ticket {{ticket}}\n" +
      "Aguardando você: {{a_pagar}} a pagar · {{a_embalar}} a embalar · {{a_enviar}} a enviar\n" +
      "Data marcada: {{sair_hoje}} pedido(s) precisam sair hoje
" +
      "A Lia atendeu {{lia_conversas}} conversa(s) e fechou {{lia_pedidos}} pedido(s) 🤎{{edicoes}}",
    variables: [
      "dia",
      "data",
      "vendas",
      "pedidos",
      "ticket",
      "a_pagar",
      "a_embalar",
      "a_enviar",
      "sair_hoje",
      "lia_conversas",
      "lia_pedidos",
      "lia_custo",
      "loja",
      "edicoes",
    ],
  },
];
