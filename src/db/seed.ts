import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { settings, waTemplates } from "./schema";
import { initialSettings, initialWaTemplates } from "./seed-data";

// JSON.stringify + cast garante jsonb 'null' (JSON null) em vez de NULL SQL,
// que violaria o NOT NULL da coluna value.
function toJsonb(value: unknown) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

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
