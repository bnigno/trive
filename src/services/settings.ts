// Serviço de CONFIGURAÇÕES: taxas de pagamento (vigências), política padrão
// de precificação e chaves de settings permitidas. Taxas NUNCA são editadas:
// encerra-se a vigência atual e cria-se uma nova linha (histórico completo).
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

import { debutLetterProblem, debutSignatureProblem, normalizeDebutLetter } from "@/core/edition/debut";
import { ALL_PAYMENT_METHODS, type PaymentMethod } from "@/core/orders/payment-methods";
import { cityDatesSchema } from "@/core/shipping/needed-by";
import { HOUSE_MODEL_KEYS, SCENE_KEYS, STUDIO_QUALITIES } from "@/core/studio/presets";
import * as schema from "@/db/schema";
import { auditLog, paymentFeeRules, pricingPolicies, settings } from "@/db/schema";
import { normalizeInstagramHandle, STORE_NAME_DEFAULT } from "@/lib/brand";
import { toE164BR } from "@/lib/phone";
import type { DbOrTx } from "@/queue/enqueue";
import { enqueueProductCardRefresh } from "@/services/product-cards-queue";

/** Base estrutural comum ao Db de produção, transações e o TestDb (PGlite). */
export type ServiceDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export class ServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

async function writeAudit(
  db: ServiceDb,
  entry: {
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}

// Fonte única no core: o dono edita taxa de TODOS os métodos (inclusive
// pix_manual e cash, com taxa zero por padrão).
export const PAYMENT_METHODS = ALL_PAYMENT_METHODS;
export type { PaymentMethod };

const ROUNDING_MODES = ["none", "to_90", "to_99", "to_50", "integer"] as const;
const ROUNDING_DIRECTIONS = ["up", "nearest"] as const;

// ---------------------------------------------------------------------------
// 1. Taxas de pagamento (payment_fee_rules)
// ---------------------------------------------------------------------------

export interface FeeRule {
  id: string;
  paymentMethod: PaymentMethod;
  installmentsMax: number;
  /** Fração: 0.0498 = 4,98%. */
  percentRate: number;
  fixedFeeCents: number;
  settlementDays: number;
  isReferenceForPricing: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function toFeeRule(row: typeof paymentFeeRules.$inferSelect): FeeRule {
  return {
    id: row.id,
    paymentMethod: row.paymentMethod as PaymentMethod,
    installmentsMax: row.installmentsMax,
    // numeric(7,4) chega como string do driver — converter é obrigatório.
    percentRate: Number(row.percentRate),
    fixedFeeCents: row.fixedFeeCents,
    settlementDays: row.settlementDays,
    isReferenceForPricing: row.isReferenceForPricing,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  };
}

/** Regras vigentes (effective_to IS NULL) + histórico (vigências encerradas). */
export async function getFeeRules(
  db: ServiceDb,
): Promise<{ current: FeeRule[]; history: FeeRule[] }> {
  const [currentRows, historyRows] = await Promise.all([
    db
      .select()
      .from(paymentFeeRules)
      .where(isNull(paymentFeeRules.effectiveTo))
      .orderBy(paymentFeeRules.paymentMethod, desc(paymentFeeRules.effectiveFrom)),
    db
      .select()
      .from(paymentFeeRules)
      .where(isNotNull(paymentFeeRules.effectiveTo))
      .orderBy(desc(paymentFeeRules.effectiveTo)),
  ]);
  return {
    current: currentRows.map(toFeeRule),
    history: historyRows.map(toFeeRule),
  };
}

const replaceFeeRuleSchema = z.object({
  paymentMethod: z.enum(PAYMENT_METHODS),
  /** Fração entre 0 e 1 (ex.: 4,98% = 0.0498). */
  percentRate: z
    .number()
    .min(0, "A taxa percentual não pode ser negativa.")
    .lt(1, "A taxa percentual deve ser menor que 100%."),
  fixedFeeCents: z.number().int().min(0, "A tarifa fixa não pode ser negativa."),
  settlementDays: z
    .number()
    .int()
    .min(0, "O prazo de repasse não pode ser negativo."),
  installmentsMax: z.number().int().min(1).optional(),
  isReferenceForPricing: z.boolean().optional(),
  userId: z.uuid(),
});

export type ReplaceFeeRuleInput = z.input<typeof replaceFeeRuleSchema>;

/**
 * Substitui a taxa vigente do método: encerra a vigência atual
 * (effective_to = now) e cria uma nova linha. Se `isReferenceForPricing`
 * for omitido, a nova regra herda a marcação da regra substituída — assim
 * trocar a taxa do método de referência mantém a referência.
 */
export async function replaceFeeRule(
  db: ServiceDb,
  input: ReplaceFeeRuleInput,
): Promise<FeeRule> {
  const parsed = replaceFeeRuleSchema.parse(input);

  const created = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(paymentFeeRules)
      .where(
        and(
          eq(paymentFeeRules.paymentMethod, parsed.paymentMethod),
          isNull(paymentFeeRules.effectiveTo),
        ),
      )
      .orderBy(desc(paymentFeeRules.effectiveFrom))
      .limit(1);

    const now = new Date();

    if (current) {
      await tx
        .update(paymentFeeRules)
        .set({ effectiveTo: now })
        .where(eq(paymentFeeRules.id, current.id));
    }

    const isReference =
      parsed.isReferenceForPricing ?? current?.isReferenceForPricing ?? false;

    if (isReference) {
      // Só pode existir UMA regra vigente marcada como referência.
      await tx
        .update(paymentFeeRules)
        .set({ isReferenceForPricing: false })
        .where(
          and(
            eq(paymentFeeRules.isReferenceForPricing, true),
            isNull(paymentFeeRules.effectiveTo),
          ),
        );
    }

    const [row] = await tx
      .insert(paymentFeeRules)
      .values({
        paymentMethod: parsed.paymentMethod,
        installmentsMax: parsed.installmentsMax ?? current?.installmentsMax ?? 1,
        // numeric(7,4) em modo string: gravar com exatamente 4 casas.
        percentRate: parsed.percentRate.toFixed(4),
        fixedFeeCents: parsed.fixedFeeCents,
        settlementDays: parsed.settlementDays,
        isReferenceForPricing: isReference,
        effectiveFrom: now,
      })
      .returning();

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "feerule.replace",
      entityType: "payment_fee_rule",
      entityId: row.id,
      before: current
        ? {
            feeRuleId: current.id,
            percentRate: Number(current.percentRate),
            fixedFeeCents: current.fixedFeeCents,
            settlementDays: current.settlementDays,
            isReferenceForPricing: current.isReferenceForPricing,
          }
        : null,
      after: {
        paymentMethod: parsed.paymentMethod,
        percentRate: parsed.percentRate,
        fixedFeeCents: parsed.fixedFeeCents,
        settlementDays: parsed.settlementDays,
        installmentsMax: parsed.installmentsMax ?? current?.installmentsMax ?? 1,
        isReferenceForPricing: isReference,
      },
    });

    return row;
  });

  return toFeeRule(created);
}

// ---------------------------------------------------------------------------
// 2. Política padrão de precificação (pricing_policies, escopo global)
// ---------------------------------------------------------------------------

export interface DefaultPolicy {
  id: string;
  name: string;
  /** Fração: 0.3 = 30%. */
  targetMarginRate: number;
  minMarginRate: number;
  otherCostsFixedCents: number;
  otherCostsRate: number;
  roundingMode: (typeof ROUNDING_MODES)[number];
  roundingDirection: (typeof ROUNDING_DIRECTIONS)[number];
  updatedAt: Date;
}

function toDefaultPolicy(row: typeof pricingPolicies.$inferSelect): DefaultPolicy {
  return {
    id: row.id,
    name: row.name,
    targetMarginRate: Number(row.targetMarginRate),
    minMarginRate: Number(row.minMarginRate),
    otherCostsFixedCents: row.otherCostsFixedCents,
    otherCostsRate: Number(row.otherCostsRate),
    roundingMode: z.enum(ROUNDING_MODES).parse(row.roundingMode),
    roundingDirection: z.enum(ROUNDING_DIRECTIONS).parse(row.roundingDirection),
    updatedAt: row.updatedAt,
  };
}

/** Política global ativa mais recente (a "política padrão" da loja). */
export async function getDefaultPolicy(
  db: ServiceDb,
): Promise<DefaultPolicy | null> {
  const [row] = await db
    .select()
    .from(pricingPolicies)
    .where(
      and(
        eq(pricingPolicies.scopeType, "global"),
        eq(pricingPolicies.isActive, true),
      ),
    )
    .orderBy(desc(pricingPolicies.updatedAt))
    .limit(1);
  return row ? toDefaultPolicy(row) : null;
}

const updateDefaultPolicySchema = z
  .object({
    /** Fração entre 0 e 1 (ex.: 30% = 0.3). */
    targetMarginRate: z
      .number()
      .min(0, "A margem alvo não pode ser negativa.")
      .lt(1, "A margem alvo deve ser menor que 100%."),
    minMarginRate: z
      .number()
      .min(0, "A margem mínima não pode ser negativa.")
      .lt(1, "A margem mínima deve ser menor que 100%."),
    roundingMode: z.enum(ROUNDING_MODES),
    roundingDirection: z.enum(ROUNDING_DIRECTIONS),
    otherCostsFixedCents: z
      .number()
      .int()
      .min(0, "Os custos fixos não podem ser negativos."),
    userId: z.uuid(),
  })
  .refine((value) => value.minMarginRate <= value.targetMarginRate, {
    message: "A margem mínima não pode ser maior que a margem alvo.",
  });

export type UpdateDefaultPolicyInput = z.input<typeof updateDefaultPolicySchema>;

/** Atualiza (ou cria, se não existir) a política global padrão. */
export async function updateDefaultPolicy(
  db: ServiceDb,
  input: UpdateDefaultPolicyInput,
): Promise<DefaultPolicy> {
  const parsed = updateDefaultPolicySchema.parse(input);

  const saved = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(pricingPolicies)
      .where(
        and(
          eq(pricingPolicies.scopeType, "global"),
          eq(pricingPolicies.isActive, true),
        ),
      )
      .orderBy(desc(pricingPolicies.updatedAt))
      .limit(1);

    const values = {
      targetMarginRate: parsed.targetMarginRate.toFixed(4),
      minMarginRate: parsed.minMarginRate.toFixed(4),
      roundingMode: parsed.roundingMode,
      roundingDirection: parsed.roundingDirection,
      otherCostsFixedCents: parsed.otherCostsFixedCents,
      updatedAt: new Date(),
    };

    let row: typeof pricingPolicies.$inferSelect;
    if (current) {
      [row] = await tx
        .update(pricingPolicies)
        .set(values)
        .where(eq(pricingPolicies.id, current.id))
        .returning();
    } else {
      [row] = await tx
        .insert(pricingPolicies)
        .values({ name: "Política padrão", scopeType: "global", ...values })
        .returning();
    }

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "pricing_policy.update",
      entityType: "pricing_policy",
      entityId: row.id,
      before: current
        ? {
            targetMarginRate: Number(current.targetMarginRate),
            minMarginRate: Number(current.minMarginRate),
            roundingMode: current.roundingMode,
            roundingDirection: current.roundingDirection,
            otherCostsFixedCents: current.otherCostsFixedCents,
          }
        : null,
      after: {
        targetMarginRate: parsed.targetMarginRate,
        minMarginRate: parsed.minMarginRate,
        roundingMode: parsed.roundingMode,
        roundingDirection: parsed.roundingDirection,
        otherCostsFixedCents: parsed.otherCostsFixedCents,
      },
    });

    return row;
  });

  return toDefaultPolicy(saved);
}

// ---------------------------------------------------------------------------
// 3. Settings (chaves permitidas)
// ---------------------------------------------------------------------------

const SETTING_VALUE_SCHEMAS: Record<string, z.ZodType> = {
  /** Fração: 0.1 = 10% de variação máxima sem aprovação. */
  price_change_pct_threshold: z
    .number()
    .min(0, "O limite de variação não pode ser negativo.")
    .max(1, "O limite de variação deve ser no máximo 100%."),
  first_price_requires_approval: z.boolean(),
  default_low_stock_threshold: z
    .number()
    .int()
    .min(0, "O limiar de estoque baixo não pode ser negativo."),
  stock_reservation_ttl_minutes: z
    .number()
    .int()
    .positive("O tempo de reserva deve ser maior que zero."),
  /**
   * Pagamento automático via Mercado Pago na loja. O toggle sozinho não basta:
   * isMpEnabled (store-payments) também exige credenciais (ou ADAPTER_MODE
   * fake) — sem elas a loja segue no modo manual, sem quebrar nada.
   */
  mp_enabled: z.boolean(),
  // --- Dados da loja (rodapé e páginas legais — Decreto 7.962/2013) ---
  store_name: z.string().trim().max(120, "O nome da loja é longo demais."),
  store_cnpj: z.string().trim().max(20, "CNPJ longo demais."),
  store_address: z.string().trim().max(300, "O endereço é longo demais."),
  store_email: z
    .string()
    .trim()
    .max(200, "O e-mail é longo demais.")
    .refine(
      (value) => value === "" || z.email().safeParse(value).success,
      "E-mail inválido.",
    ),
  store_whatsapp: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "") return "";
      const e164 = toE164BR(value);
      if (!e164) {
        ctx.addIssue({
          code: "custom",
          message:
            "WhatsApp inválido. Informe DDD + número, ex.: (11) 99999-8888.",
        });
        return z.NEVER;
      }
      return e164;
    }),
  store_instagram: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const handle = normalizeInstagramHandle(value);
      if (handle === null) {
        ctx.addIssue({ code: "custom", message: "Instagram inválido. Informe o usuário, ex.: @trive_mfeminine." });
        return z.NEVER;
      }
      return handle;
    }),
  // --- Correios automático (SuperFrete), ligado em /admin/frete ---
  /**
   * CEP de origem das postagens; vazio = a cotação automática não roda. Gravado
   * SEMPRE com hífen ("66045-335"): um jsonb só de dígitos volta do banco como
   * número (dupla análise do Drizzle) e perderia a forma.
   */
  store_cep: z
    .string()
    .trim()
    .transform((value) => value.replace(/\D/g, ""))
    .refine((digits) => digits === "" || /^\d{8}$/.test(digits), "CEP inválido. Informe os 8 dígitos, ex.: 66045-335.")
    .transform((digits) => (digits === "" ? "" : `${digits.slice(0, 5)}-${digits.slice(5)}`)),
  /**
   * Cotação automática dos Correios (PAC/SEDEX pela SuperFrete) para os CEPs
   * sem faixa. Como mp_enabled: o toggle sozinho não basta — exige
   * SUPERFRETE_TOKEN no ambiente (ou ADAPTER_MODE fake) e store_cep; sem
   * isso, os CEPs sem faixa seguem com o frete calculado pela equipe.
   */
  correios_auto_enabled: z.boolean(),
  /** Acréscimo de embalagem por pedido somado ao preço dos Correios, em centavos (padrão R$ 3,00). */
  correios_surcharge_cents: z
    .number()
    .int("O acréscimo precisa ser um valor em centavos inteiros.")
    .min(0, "O acréscimo não pode ser negativo.")
    .max(10_000, "O acréscimo vai até R$ 100,00."),
  // --- O que a Lia sabe da loja (ficha fixa do prompt; vazio = sem a linha) ---
  store_hours: z.string().trim().max(200, "O horário de atendimento vai até 200 caracteres."),
  store_pickup: z.string().trim().max(300, "A retirada vai até 300 caracteres."),
  store_about: z.string().trim().max(600, "O texto sobre a loja vai até 600 caracteres."),
  // --- Vitrine (textos da home editáveis pelo dono; vazio = texto padrão) ---
  store_tagline: z
    .string()
    .trim()
    .max(140, "A frase da loja deve ter no máximo 140 caracteres."),
  store_manifesto: z
    .string()
    .trim()
    .max(600, "O manifesto deve ter no máximo 600 caracteres."),
  // --- WhatsApp automático (Fase 4) ---
  /**
   * Mensageria WhatsApp via Z-API. Como mp_enabled: o toggle sozinho não
   * basta — isWaEnabled (wa-messaging) também exige as credenciais Z-API no
   * ambiente (ou ADAPTER_MODE fake, que só atende testes).
   */
  wa_enabled: z.boolean(),
  /** Número do dono para avisos internos — E.164 (vazio desliga os avisos). */
  owner_whatsapp_phone: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "") return "";
      const e164 = toE164BR(value);
      if (!e164) {
        ctx.addIssue({
          code: "custom",
          message:
            "WhatsApp inválido. Informe DDD + número, ex.: (11) 99999-8888.",
        });
        return z.NEVER;
      }
      return e164;
    }),
  /** Minutos após o pedido para o ÚNICO lembrete de pagamento (15 min a 12 h). */
  wa_recovery_after_minutes: z
    .number()
    .int("Informe um número inteiro de minutos.")
    .min(15, "O lembrete deve esperar pelo menos 15 minutos.")
    .max(720, "O lembrete deve sair em até 720 minutos (12 horas)."),
  // --- Bot de vendas com IA (Fase 5) ---
  /**
   * Como wa_enabled: o toggle sozinho não basta — o bot também exige a chave
   * da Anthropic no ambiente (ou ADAPTER_MODE fake) e wa_enabled ativo.
   */
  bot_enabled: z.boolean(),
  bot_model: z.enum(["claude-sonnet-5", "claude-haiku-4-5"], {
    error: "Modelo inválido. Escolha entre claude-sonnet-5 e claude-haiku-4-5.",
  }),
  /** autonomous = a Lia responde sozinha; copilot = ela sugere e a dona aprova na Central. */
  bot_mode: z.enum(["autonomous", "copilot"], { error: "Modo inválido. Escolha entre autonomous e copilot." }),
  /** Retomar sacola parada após N horas (0 = desligado; até 168). */
  bot_idle_cart_followup_hours: z.number().int().min(0).max(168, { error: "No máximo 168 horas (7 dias)." }),
  /** Instruções extras do dono anexadas ao prompt do bot (pode ficar vazio). */
  bot_extra_instructions: z
    .string()
    .trim()
    .max(2000, "As instruções extras devem ter no máximo 2000 caracteres."),
  /**
   * Chave Pix da LOJA para o Pix manual (plano B do robô quando o link de
   * pagamento falha). Vazia = recurso desligado — a ferramenta
   * enviar_chave_pix responde indisponível.
   */
  store_pix_key: z
    .string()
    .trim()
    .max(140, "A chave Pix deve ter no máximo 140 caracteres."),
  // --- Vendedora do WhatsApp (Onda 3) ---
  /** Nome da vendedora virtual (vazio = padrão do prompt). */
  bot_seller_name: z
    .string()
    .trim()
    .max(40, "O nome da vendedora deve ter no máximo 40 caracteres."),
  /**
   * Política de troca em texto corrido, anexada ao prompt: é o que permite à
   * vendedora responder "posso trocar?" sem inventar. Vazia = ela transfere.
   */
  store_exchange_policy: z
    .string()
    .trim()
    .max(600, "A política de troca deve ter no máximo 600 caracteres."),
  /** Respostas rápidas do painel de conversas, uma por linha. */
  wa_quick_replies: z
    .string()
    .trim()
    .max(2000, "As respostas rápidas devem ter no máximo 2000 caracteres."),
  /** "Bom dia da maison": imagem diária às 8h no WhatsApp do dono. Ausente = ligado. */
  owner_digest_enabled: z.boolean(),
  /**
   * A vendedora vê fotos e ouve áudios das clientes (visão do modelo +
   * transcrição). Ausente = ligado; o áudio ainda exige OPENAI_API_KEY.
   */
  bot_media_enabled: z.boolean(),
  /**
   * A vendedora reconhece a peça do catálogo na foto que a cliente manda
   * (impressão digital das fotos + comparação visual). Ausente = ligado; só
   * age quando bot_media_enabled também está ligado.
   */
  bot_photo_match_enabled: z.boolean(),
  bot_cards_enabled: z.boolean(),
  // --- Foto no corpo (ensaio com modelas da casa; Marco 1 do marketing) ---
  /**
   * Como bot_enabled: o toggle sozinho não basta — a geração também exige a
   * chave da FASHN no ambiente (ou ADAPTER_MODE fake) e uma foto-base
   * escolhida para a modela × cena × corpo pedidos.
   */
  ai_photos_enabled: z.boolean(),
  /** Imagens geradas por dia (contadas pelas candidatas, o fato do vendor), 1–200. */
  ai_photos_daily_quota: z.number().int().min(1, "No mínimo 1 por dia.").max(200, "No máximo 200 por dia."),
  /** economica = try-on leve (1 crédito por foto); alta = try-on em 2K (3 créditos). */
  ai_photos_quality: z.enum(STUDIO_QUALITIES, { error: "Qualidade inválida. Escolha entre economica e alta." }),
  ai_photos_default_scene: z.enum(SCENE_KEYS, { error: "Cena desconhecida." }),
  ai_photos_default_model: z.enum(HOUSE_MODEL_KEYS, { error: "Modela desconhecida." }),
  /** Foto de IA também na vitrine (padrão: só no post do Instagram e nos cartões da Lia). */
  ai_photos_in_store: z.boolean(),
  /** Janela de envio em lote (avisos de "voltou", convites VIP), horas de São Paulo. */
  wa_send_window_start: z.number().int().min(0).max(23),
  wa_send_window_end: z.number().int().min(1).max(24),
  /** Intervalo entre mensagens de um mesmo lote (segundos). */
  wa_bulk_interval_seconds: z.number().int().min(5).max(300),
  /** Prazo da reserva gentil (horas). */
  hold_ttl_hours: z.number().int().min(1).max(168),
  /** Silêncio da vendedora depois de transferir para a equipe (horas, 1–168). */
  handoff_silence_hours: z
    .number()
    .int()
    .min(1, "O silêncio após transferir vai de 1 a 168 horas.")
    .max(168, "O silêncio após transferir vai de 1 a 168 horas."),
  /** Conversa "com você" parada por N horas volta para a vendedora (0 = nunca; até 168). */
  handoff_auto_return_hours: z
    .number()
    .int()
    .min(0, "A volta automática vai de 0 (nunca) a 168 horas.")
    .max(168, "A volta automática vai de 0 (nunca) a 168 horas."),
  /** Teto de convidadas por lançamento VIP. */
  drop_audience_limit: z.number().int().min(1).max(500),
  /** "Começar pela foto" no cadastro de peça (ausente = ligado). */
  catalog_draft_enabled: z.boolean(),
  atelier_enabled: z.boolean(),
  feedback_ask_enabled: z.boolean(),
  /** Cupom de desculpas quando o motoboy entrega depois da janela prometida + carência. */
  late_delivery_coupon_enabled: z.boolean(),
  late_delivery_grace_minutes: z.number().int().min(0).max(240, { error: "No máximo 240 minutos (4 horas)." }),
  late_delivery_coupon_percent: z.number().int().min(1).max(50, { error: "Entre 1% e 50%." }),
  late_delivery_coupon_days: z.number().int().min(1).max(180, { error: "Entre 1 e 180 dias." }),
  /** Gentilezas da Lia: cota diária de cupons pessoais que a vendedora pode oferecer. */
  lia_gift_enabled: z.boolean(),
  lia_gift_percent: z.number().int().min(1).max(50, { error: "Entre 1% e 50%." }),
  lia_gift_daily_quota: z.number().int().min(0).max(20, { error: "No máximo 20 por dia." }),
  lia_gift_min_purchases: z.number().int().min(0).max(10),
  lia_gift_min_cart_cents: z.number().int().min(0),
  lia_gift_days: z.number().int().min(1).max(30, { error: "Entre 1 e 30 dias." }),
  lia_gift_cooldown_days: z.number().int().min(0).max(365),
  /** Mimo pela foto do "Quem já vestiu": cupom pessoal quando ela manda a foto com a peça que comprou. */
  look_coupon_enabled: z.boolean(),
  look_coupon_percent: z.number().int().min(1).max(50, { error: "Entre 1% e 50%." }),
  look_coupon_days: z.number().int().min(1).max(180, { error: "Entre 1 e 180 dias." }),
  /** Proteção de preço: peça baixou em até N dias depois do pagamento → a diferença vira cupom. */
  price_protection_enabled: z.boolean(),
  price_protection_days: z.number().int().min(1).max(60, { error: "Entre 1 e 60 dias." }),
  /** Vales de papel na caixa: "para você", "para uma amiga" e o prêmio de quem indicou. */
  paper_voucher_enabled: z.boolean(),
  paper_voucher_percent: z.number().int().min(1).max(50, { error: "Entre 1% e 50%." }),
  referral_percent: z.number().int().min(1).max(50, { error: "Entre 1% e 50%." }),
  referral_reward_percent: z.number().int().min(1).max(50, { error: "Entre 1% e 50%." }),
  paper_voucher_days: z.number().int().min(7).max(180, { error: "Entre 7 e 180 dias." }),
  /** "Quem já vestiu": a Lia guarda a foto da cliente com a peça e pede consentimento. */
  customer_looks_enabled: z.boolean(),
  /** A Lia manda a nota em áudio da curadora como mensagem de voz (ausente = ligado). */
  bot_audio_notes_enabled: z.boolean(),
  /** Datas da cidade (Círio, Natal…): o selo da vitrine e o "faltam N dias" do Bom dia. */
  city_dates: cityDatesSchema,
  // --- Provador (grupos de WhatsApp da marca) ---
  /** Interruptor geral dos grupos: desligado, nenhum post sai e nenhum sinal é lido. Ausente = desligado. */
  groups_enabled: z.boolean(),
  /** A Lia responde quando chamada (@Lia) no grupo. Ausente = desligado. */
  bot_group_mentions_enabled: z.boolean(),
  /** Teto de posts da marca por semana em cada sala (1–7). */
  group_posts_per_week: z
    .number()
    .int()
    .min(1, "O Provador recebe de 1 a 7 posts por semana.")
    .max(7, "O Provador recebe de 1 a 7 posts por semana."),
  /** Kill switch: % de membras que saem nas 24 h após um post para pausar a sala (0 = desligado). */
  group_kill_switch_pct: z
    .number()
    .int()
    .min(0, "A pausa automática vai de 0 (desligada) a 50%.")
    .max(50, "A pausa automática vai de 0 (desligada) a 50%."),
  /** Mimo de boas-vindas: cupom pessoal de primeira compra para quem entra no Provador pela Lia. */
  provador_welcome_gift_enabled: z.boolean(),
  provador_welcome_gift_percent: z.number().int().min(1, "Entre 1% e 50%.").max(50, "Entre 1% e 50%."),
  provador_welcome_gift_days: z.number().int().min(1, "Entre 1 e 90 dias.").max(90, "Entre 1 e 90 dias."),
  /** Nome da edição em cartaz (ex.: "Edição Círio"): entra no post e na legenda. */
  edition_name: z
    .string()
    .trim()
    .max(40, "O nome da edição deve ter no máximo 40 caracteres."),
  /**
   * A carta de estreia (primeira compra): vazio = a carta não sai. Quebras
   * de linha do navegador (CRLF) viram LF antes de contar; o teto de
   * verdade é o papel de 15 × 10 cm — a limpeza e o orçamento do core dizem
   * se cabe, com a razão para a dona.
   */
  debut_letter_text: z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .superRefine((value, ctx) => {
      const problem = debutLetterProblem(normalizeDebutLetter(value));
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  /** Como a dona assina a carta; vazio = "A curadora". Cabe numa linha (largura, não caracteres). */
  debut_letter_signature: z
    .string()
    .trim()
    .max(60, "A assinatura vai até 60 caracteres.")
    .superRefine((value, ctx) => {
      const problem = debutSignatureProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
};

export const ALLOWED_SETTING_KEYS = Object.keys(SETTING_VALUE_SCHEMAS);

export async function getSettingsMap(
  db: ServiceDb,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, keys));
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** O nome da loja como a dona escreveu (setting store_name), com o fallback oficial. */
export async function getStoreName(db: ServiceDb): Promise<string> {
  const map = await getSettingsMap(db, ["store_name"]);
  const value = map["store_name"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : STORE_NAME_DEFAULT;
}

const updateSettingSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  userId: z.uuid(),
});

export type UpdateSettingInput = z.input<typeof updateSettingSchema>;

export async function updateSetting(
  db: ServiceDb,
  input: UpdateSettingInput,
): Promise<{ key: string; value: unknown }> {
  const parsed = updateSettingSchema.parse(input);

  const valueSchema = SETTING_VALUE_SCHEMAS[parsed.key];
  if (!valueSchema) {
    throw new ServiceError(
      "setting_desconhecida",
      `Configuração desconhecida: "${parsed.key}". Esta chave não pode ser alterada por aqui.`,
    );
  }

  const valueResult = valueSchema.safeParse(parsed.value);
  if (!valueResult.success) {
    throw new ServiceError(
      "valor_invalido",
      valueResult.error.issues[0]?.message ??
        `Valor inválido para a configuração "${parsed.key}".`,
    );
  }
  const value = valueResult.data;

  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, parsed.key))
      .limit(1);

    await tx
      .insert(settings)
      .values({ key: parsed.key, value, updatedBy: parsed.userId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: parsed.userId, updatedAt: new Date() },
      });

    await writeAudit(tx, {
      actorId: parsed.userId,
      action: "setting.update",
      entityType: "setting",
      entityId: parsed.key,
      before: current ? { value: current.value } : null,
      after: { value },
    });

    // A edição e o nome da loja estão na faixa de todos os cartões: cada peça
    // ativa é redesenhada em segundo plano, uma de cada vez.
    if (CARD_SETTING_KEYS.has(parsed.key) && (current?.value ?? null) !== value) {
      const active = await tx
        .select({ id: schema.products.id })
        .from(schema.products)
        .where(and(eq(schema.products.status, "active"), isNull(schema.products.deletedAt)));
      await enqueueProductCardRefresh(tx as unknown as DbOrTx, {
        productIds: active.map((row) => row.id),
        reason: parsed.key,
      });
    }
  });

  return { key: parsed.key, value };
}

/** Configurações que aparecem escritas no post da peça. */
const CARD_SETTING_KEYS = new Set(["edition_name", "store_name"]);
