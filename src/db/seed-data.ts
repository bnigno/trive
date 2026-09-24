// Dados iniciais do seed — arrays PUROS, sem efeito colateral ao importar:
// o seed (src/db/seed.ts) e o scripts/sync-seed.ts (produção) leem daqui.
// Chaves de settings e templates são FIXAS: o painel só edita valores/textos.

export type SeedSetting = { key: string; value: unknown };
export type SeedWaTemplate = { key: string; label: string; bodyTemplate: string; variables: string[] };

export const initialSettings: Array<{ key: string; value: unknown }> = [
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
  // O que a Lia sabe da loja (ficha do prompt): preencher em /admin/configuracoes.
  { key: "store_hours", value: "" },
  { key: "store_pickup", value: "" },
  { key: "store_about", value: "" },
  // Correios automático (SuperFrete): desligado até a dona ligar em /admin/frete
  // e preencher o CEP de origem; acréscimo de embalagem R$ 3,00 por pedido.
  { key: "store_cep", value: "" },
  { key: "correios_auto_enabled", value: false },
  { key: "correios_surcharge_cents", value: 300 },
  // Fase 4 — WhatsApp (Z-API). wa_enabled fica false até o dono conectar a
  // sessão; recuperação de pedido não pago dispara após N minutos (UMA vez).
  { key: "wa_enabled", value: false },
  { key: "wa_recovery_after_minutes", value: 60 },
  // Fase 5 — Bot de vendas com IA. Desligado até o dono ativar no admin.
  { key: "bot_enabled", value: false },
  { key: "bot_model", value: "claude-sonnet-5" },
  // Modo da vendedora: sozinha (autonomous) ou copiloto (sugere, a dona aprova).
  { key: "bot_mode", value: "autonomous" },
  // Retomada de sacola parada após N horas (0 = desligado).
  { key: "bot_idle_cart_followup_hours", value: 0 },
  { key: "bot_extra_instructions", value: "" },
  // Fase 6 — chave Pix da LOJA para Pix manual (plano B do robô).
  // Vazia = recurso desligado; o dono cadastra em /admin/configuracoes.
  { key: "store_pix_key", value: "" },
  { key: "owner_digest_enabled", value: true },
  { key: "bot_media_enabled", value: true },
  // A Lia reconhece a peça do catálogo na foto da cliente (hash + visão).
  { key: "bot_photo_match_enabled", value: true },
  { key: "bot_cards_enabled", value: true },
  // Foto no corpo (ensaio com modelos da casa): nasce desligado — a dona liga
  // depois de escolher as fotos-base e de ver o smoke real de uma peça.
  { key: "ai_photos_enabled", value: false },
  { key: "ai_photos_daily_quota", value: 30 },
  { key: "ai_photos_quality", value: "economica" },
  { key: "ai_photos_default_scene", value: "sala_clara" },
  { key: "ai_photos_default_model", value: "modelo_a" },
  { key: "ai_photos_in_store", value: false },
  { key: "wa_send_window_start", value: 9 },
  { key: "wa_send_window_end", value: 21 },
  { key: "wa_bulk_interval_seconds", value: 20 },
  { key: "hold_ttl_hours", value: 24 },
  // Onda 5 — transferência: silêncio da vendedora e volta automática.
  { key: "handoff_silence_hours", value: 24 },
  { key: "handoff_auto_return_hours", value: 12 },
  { key: "drop_audience_limit", value: 60 },
  { key: "catalog_draft_enabled", value: true },
  // "Chegou bem?": a lista tocável um dia depois da entrega.
  { key: "feedback_ask_enabled", value: true },
  // Cupons automáticos: todos nascem desligados até a dona ligar em /admin/cupons.
  { key: "late_delivery_coupon_enabled", value: false },
  { key: "late_delivery_grace_minutes", value: 30 },
  { key: "late_delivery_coupon_percent", value: 10 },
  { key: "late_delivery_coupon_days", value: 30 },
  // Gentilezas da Lia (cupom de bolso): desligado até a dona ligar em /admin/whatsapp.
  { key: "lia_gift_enabled", value: false },
  { key: "lia_gift_percent", value: 10 },
  { key: "lia_gift_daily_quota", value: 3 },
  { key: "lia_gift_min_purchases", value: 1 },
  { key: "lia_gift_min_cart_cents", value: 15000 },
  { key: "lia_gift_days", value: 2 },
  { key: "lia_gift_cooldown_days", value: 60 },
  // Mimo pela foto (Quem já vestiu): desligado até a dona ligar em /admin/cupons.
  { key: "look_coupon_enabled", value: false },
  { key: "look_coupon_percent", value: 10 },
  { key: "look_coupon_days", value: 60 },
  // Proteção de preço: desligada até a dona ligar em /admin/cupons.
  { key: "price_protection_enabled", value: false },
  { key: "price_protection_days", value: 14 },
  // Vales de papel na caixa: desligado até a dona ligar em /admin/cupons.
  { key: "paper_voucher_enabled", value: false },
  { key: "paper_voucher_percent", value: 10 },
  { key: "referral_percent", value: 10 },
  { key: "referral_reward_percent", value: 10 },
  { key: "paper_voucher_days", value: 45 },
  // "Quem já vestiu": foto da cliente com a peça vira cartão + consentimento.
  { key: "customer_looks_enabled", value: true },
  // Provador (grupos): nasce desligado — a dona liga quando registrar a primeira sala.
  { key: "groups_enabled", value: false },
  { key: "bot_group_mentions_enabled", value: false },
  { key: "group_posts_per_week", value: 3 },
  { key: "group_kill_switch_pct", value: 2 },
  { key: "provador_welcome_gift_enabled", value: false },
  { key: "provador_welcome_gift_percent", value: 10 },
  { key: "provador_welcome_gift_days", value: 30 },
  // A voz da curadora: a Lia manda a nota em áudio da peça pelo WhatsApp.
  { key: "bot_audio_notes_enabled", value: true },
  // Ateliê pelo WhatsApp: fotos + recado do dono viram rascunho de peça.
  { key: "atelier_enabled", value: true },
  // Entrevista da curadora: nasce desligada; a dona escolhe a hora no painel.
  { key: "curator_interview_enabled", value: false },
  { key: "curator_interview_hour", value: 10 },
  { key: "curator_interview_weekends", value: false },
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
      "{{nome}}, este é o comprovante do pagamento do pedido #{{pedido}}. A {{loja}} agradece. 🤍\n" +
      "Acompanhe: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "loja", "link"],
  },
  {
    // Foto do pacote (legenda da imagem): sai quando o dono registra a
    // embalagem com foto; só com opt-in; uma vez por pedido.
    key: "order_packed",
    label: "Peça embalada (legenda da foto)",
    bodyTemplate:
      "{{nome}}, sua peça foi embalada com carinho 🤎\n" +
      "O pedido #{{pedido}} já está pronto para seguir viagem — {{proximo}}.\n" +
      "Acompanhe: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "link", "proximo"],
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
      "Boa notícia, {{nome}}! Seu pedido #{{pedido}} saiu da {{loja}} e chega {{dia}}, entre {{janela}}. 🛵\n" +
      "Acompanhe por aqui: {{link}}\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "dia", "janela", "loja", "link"],
  },
  {
    key: "order_delivered",
    label: "Pedido entregue (legenda da foto)",
    bodyTemplate:
      "{{nome}}, seu pedido #{{pedido}} foi entregue {{entrega}} 🤎\n" +
      "Se precisar de qualquer coisa com a peça, é só chamar.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "entrega", "recebido_por"],
  },
  {
    key: "late_delivery_coupon",
    label: "Desculpas pelo atraso do motoboy (cupom)",
    bodyTemplate:
      "{{nome}}, desculpa pelo atraso 🤎\n" +
      "A entrega do pedido #{{pedido}} passou {{atraso}} da janela combinada — não é o nosso jeito.\n" +
      "Para compensar, o cupom {{cupom}} vale {{valor}} na sua próxima compra, até {{validade}}: é só dizer o código por aqui ou usar em {{link}}.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "atraso", "cupom", "valor", "validade", "link"],
  },
  {
    key: "price_protection_coupon",
    label: "Proteção de preço (cupom da diferença)",
    bodyTemplate:
      "{{nome}}, {{peca}} que você levou no pedido #{{pedido}} baixou de preço — e quem comprou antes não fica para trás 🤎\n" +
      "A diferença ({{valor}}) virou o cupom {{cupom}}, válido até {{validade}}, para a próxima compra: é só dizer o código por aqui ou usar em {{link}}.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "peca", "pedido", "valor", "cupom", "validade", "link"],
  },
  {
    key: "referral_reward_coupon",
    label: "Prêmio da indicação (a amiga usou o vale)",
    bodyTemplate:
      "{{nome}}, {{amiga}} usou o seu vale e fez a primeira compra 🤎\n" +
      "O seu presente: cupom {{cupom}} de {{valor}}, válido até {{validade}} — é só dizer o código por aqui ou usar em {{link}}.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "amiga", "cupom", "valor", "validade", "link"],
  },
  {
    key: "delivery_feedback_ask",
    label: "Chegou bem? (lista 24 h após a entrega)",
    bodyTemplate:
      "{{nome}}, chegou bem? 🤎\n" +
      "Conta pra gente como ficou {{peca}} do pedido #{{pedido}} — é um toque só.\n" +
      "Para não receber avisos, responda SAIR.",
    variables: ["nome", "pedido", "peca"],
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
    // O MP recebeu valor diferente do total do pedido (ex.: link antigo pago).
    key: "owner_amount_divergent",
    label: "[interno] Valor pago diferente do pedido",
    bodyTemplate:
      "Valor pago diferente no pedido #{{pedido}} ⚠️\n" +
      "Cliente: {{cliente}}\n" +
      "Pedido: {{esperado}} · Pago: {{pago}} · Diferença: {{diferenca}}\n" +
      "Confira no painel e acerte a diferença com a cliente.",
    variables: ["pedido", "cliente", "esperado", "pago", "diferenca"],
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
    // Provador: depois do "Passou pelo Provador", a peça no tamanho e na cor
    // dela — só com afinidade, opt-in e na janela; um aviso por pessoa por post.
    key: "provador_affinity",
    label: "Provador: chegou no seu tamanho",
    bodyTemplate:
      "{{nome}}, das peças que entraram no Provador hoje, {{peca}} {{motivo}}. Quer que eu segure por {{horas}} h no {{tamanho}}? Se não for a hora, tudo bem — ela vai para a vitrine em breve.",
    variables: ["nome", "peca", "motivo", "horas", "tamanho"],
  },
  {
    // Provador: sobrou uma unidade no tamanho de quem reagiu ao post — no
    // máximo um aviso por semana por pessoa.
    key: "provador_last_unit",
    label: "Provador: ficou a última no seu tamanho",
    bodyTemplate:
      "Você curtiu {{peca}} no Provador. Ficou uma em {{tamanho}}. Não é pressão — é só para você não descobrir depois. Segura?",
    variables: ["nome", "peca", "tamanho"],
  },
  {
    // Provador: a vencedora da enquete chegou — quem votou nela sabe primeiro.
    key: "provador_poll_winner",
    label: "Provador: a cor que você votou chegou",
    bodyTemplate:
      "Deu {{opcao}} — e você votou nela. {{peca}} chegou: tem {{quantidade}} agora. Suas {{horas}} h de reserva começam agora; me diz \"segura\" que eu guardo.",
    variables: ["nome", "opcao", "peca", "quantidade", "horas"],
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
    key: "owner_atelier_draft",
    label: "[interno] Ateliê: rascunho pronto",
    bodyTemplate:
      "🧵 Rascunho pronto · {{peca}} · {{fotos}}{{detalhes}}\n" +
      "Revise a ficha e publique quando quiser: {{link}}",
    variables: ["peca", "fotos", "detalhes", "link"],
  },
  {
    key: "owner_atelier_card",
    label: "[interno] Ateliê: cartão do rascunho (legenda)",
    bodyTemplate: "🧵 {{peca}}{{detalhes}}\n{{link}}",
    variables: ["peca", "detalhes", "link"],
  },
  {
    key: "owner_atelier_nudge",
    label: "[interno] Ateliê: faltou o recado",
    bodyTemplate: "Recebi {{fotos}} 📸 Me conta o nome da peça, as cores, os tamanhos e quanto custou — texto ou áudio — que eu monto a ficha.",
    variables: ["fotos"],
  },
  {
    key: "owner_atelier_help",
    label: "[interno] Ateliê: como cadastrar",
    bodyTemplate:
      "Para cadastrar uma peça por aqui: mande as fotos primeiro (pela galeria) e, em seguida, um recado com o nome dela — texto ou áudio. {{motivo}}",
    variables: ["motivo"],
  },
  {
    key: "owner_interview_ask",
    label: "[interno] Entrevista da curadora: a pergunta do dia",
    bodyTemplate:
      "🎙️ Pergunta do dia · {{peca}}\n{{pergunta}}\n\n" +
      "Me responde com um áudio até hoje à noite — 20 segundos bastam (pode mandar mais de um). Eu transformo na nota da peça e em duas legendas, e só salvo com o seu ok. " +
      "Prefere escrever? Comece com *resposta:*. Se hoje não der, responda *pula*.",
    variables: ["peca", "pergunta"],
  },
  {
    key: "owner_interview_draft",
    label: "[interno] Entrevista da curadora: rascunho para aprovar",
    bodyTemplate:
      "✍️ Rascunho · {{peca}}\n\n*Nota da curadora*\n{{nota}}{{legendas}}{{aviso}}\n\n" +
      "Responda:\n*ok* — salvo a nota na peça\n" +
      "*ok voz* — salvo a nota E o seu áudio, inteiro como você mandou: ele passa a tocar na página da peça e a vendedora envia às clientes\n" +
      "*corrige:* e o que mudar — eu reescrevo\n*nova:* e a nota inteira do seu jeito\n*pula* — deixo pra lá",
    variables: ["peca", "nota", "legendas", "aviso"],
  },
  {
    key: "owner_interview_saved",
    label: "[interno] Entrevista da curadora: nota salva",
    bodyTemplate: "✅ Nota salva em {{peca}}: já aparece na página da peça e a {{vendedora}} usa quando perguntarem dela.{{voz}}",
    variables: ["peca", "vendedora", "voz"],
  },
  {
    key: "owner_interview_skipped",
    label: "[interno] Entrevista da curadora: pulada",
    bodyTemplate: "Tudo bem — deixei {{peca}} para depois. Na próxima pergunto de outra peça.",
    variables: ["peca"],
  },
  {
    key: "owner_interview_unheard",
    label: "[interno] Entrevista da curadora: áudio que não deu para ouvir",
    bodyTemplate: "Não consegui ouvir esse áudio agora 😕 Pode mandar de novo, ou escrever a resposta começando com *resposta:*.",
    variables: [],
  },
  {
    key: "owner_interview_rejected",
    label: "[interno] Entrevista da curadora: não salvei",
    bodyTemplate: "Não salvei: {{motivo}}",
    variables: ["motivo"],
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
    label: "[interno] Bom dia da TRIVÉ (legenda da imagem)",
    bodyTemplate:
      "Bom dia! ☕ Seu resumo de {{dia}}, {{data}}:\n" +
      "Vendas: {{vendas}} em {{pedidos}} pedido(s) · ticket {{ticket}}\n" +
      "Aguardando você: {{a_pagar}} a pagar · {{a_embalar}} a embalar · {{a_enviar}} a enviar\n" +
      "Data marcada: {{sair_hoje}} pedido(s) precisam sair hoje\n" +
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
