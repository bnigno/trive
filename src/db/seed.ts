import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { settings } from "./schema";

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

    console.log(
      "Seed concluído: settings, payment_fee_rules e pricing_policies garantidos.",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Falha ao rodar o seed:", error);
  process.exit(1);
});
