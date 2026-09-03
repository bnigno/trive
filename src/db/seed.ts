import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { settings, waTemplates } from "./schema";

// JSON.stringify + cast garante jsonb 'null' (JSON null) em vez de NULL SQL,
// que violaria o NOT NULL da coluna value.
function toJsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

const initialSettings: Array<{ key: string; value: unknown }> = [
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
];

// Templates iniciais de WhatsApp (pt-BR). Editáveis em /admin; o seed nunca
// sobrescreve edições (onConflictDoNothing por key). Mensagens transacionais
// ao CLIENTE terminam com a instrução SAIR (opt-out LGPD); as [interno] vão
// só para o dono e dispensam isso.
const initialWaTemplates: Array<{
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
      "Cliente: {{cliente}}",
    variables: ["pedido", "total", "cliente"],
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
    key: "owner_low_stock",
    label: "[interno] Estoque baixo",
    bodyTemplate:
      "Atenção: estoque baixo. ⚠️\n" +
      "{{produto}} (SKU {{sku}})\n" +
      "Disponível: {{disponivel}}",
    variables: ["produto", "sku", "disponivel"],
  },
  {
    key: "owner_queue_dead",
    label: "[interno] Fila com problemas",
    bodyTemplate:
      "Atenção: {{quantidade}} evento(s) na fila esgotaram as tentativas. ⚠️\n" +
      "Confira em /admin/fila.",
    variables: ["quantidade"],
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "Erro: DATABASE_URL não definida. Configure a variável no arquivo .env (veja .env.example) antes de rodar o seed.",
    );
    process.exit(1);
  }

  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client);
  try {
    for (const { key, value } of initialSettings) {
      await db
        .insert(settings)
        .values({ key, value: toJsonb(value) })
        .onConflictDoNothing({ target: settings.key });
    }

    for (const template of initialWaTemplates) {
      await db
        .insert(waTemplates)
        .values({
          key: template.key,
          label: template.label,
          bodyTemplate: template.bodyTemplate,
          variables: toJsonb(template.variables),
        })
        .onConflictDoNothing({ target: waTemplates.key });
    }

    // Taxas por forma de pagamento. Não há chave natural única (vigências
    // convivem na tabela), então WHERE NOT EXISTS evita duplicar em re-run.
    // CONFIRA as taxas reais no painel do Mercado Pago e ajuste em
    // /admin/configuracoes.
    const feeRules = [
      {
        paymentMethod: "pix",
        installmentsMax: 1,
        percentRate: "0.0099",
        fixedFeeCents: 0,
        settlementDays: 0,
        isReferenceForPricing: false,
      },
      {
        // Cartão ancora o preço = pior caso de taxa.
        paymentMethod: "credit_card",
        installmentsMax: 12,
        percentRate: "0.0498",
        fixedFeeCents: 0,
        settlementDays: 30,
        isReferenceForPricing: true,
      },
      {
        paymentMethod: "boleto",
        installmentsMax: 1,
        percentRate: "0",
        fixedFeeCents: 349,
        settlementDays: 3,
        isReferenceForPricing: false,
      },
      {
        // Pix manual (transferência direta para a chave da loja): sem taxa.
        paymentMethod: "pix_manual",
        installmentsMax: 1,
        percentRate: "0",
        fixedFeeCents: 0,
        settlementDays: 0,
        isReferenceForPricing: false,
      },
      {
        // Dinheiro na entrega: sem taxa.
        paymentMethod: "cash",
        installmentsMax: 1,
        percentRate: "0",
        fixedFeeCents: 0,
        settlementDays: 0,
        isReferenceForPricing: false,
      },
    ];
    for (const rule of feeRules) {
      await db.execute(sql`
        INSERT INTO payment_fee_rules
          (payment_method, installments_max, percent_rate, fixed_fee_cents,
           settlement_days, is_reference_for_pricing)
        SELECT ${rule.paymentMethod}, ${rule.installmentsMax},
          ${rule.percentRate}::numeric, ${rule.fixedFeeCents},
          ${rule.settlementDays}, ${rule.isReferenceForPricing}
        WHERE NOT EXISTS (
          SELECT 1 FROM payment_fee_rules
          WHERE payment_method = ${rule.paymentMethod}
        )
      `);
    }

    await db.execute(sql`
      INSERT INTO pricing_policies
        (name, scope_type, target_margin_rate, min_margin_rate,
         rounding_mode, rounding_direction, is_active)
      SELECT 'default', 'global', 0.3000, 0.1500, 'to_90', 'up', true
      WHERE NOT EXISTS (
        SELECT 1 FROM pricing_policies
        WHERE name = 'default' AND scope_type = 'global'
      )
    `);

    // Frete padrão da loja (Fase 2): uma regra única para todo o Brasil.
    // Ajustar valores/faixas em /admin.
    await db.execute(sql`
      INSERT INTO shipping_rates
        (name, cep_start, cep_end, weight_min_grams, weight_max_grams,
         price_cents, delivery_days_min, delivery_days_max, is_active,
         sort_order)
      SELECT 'Entrega padrão (todo o Brasil)', '00000000', '99999999',
        0, 30000, 2000, 4, 10, true, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM shipping_rates
        WHERE name = 'Entrega padrão (todo o Brasil)'
      )
    `);

    console.log(
      "Seed concluído: settings, wa_templates, payment_fee_rules, pricing_policies e shipping_rates garantidos.",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Falha ao rodar o seed:", error);
  process.exit(1);
});
