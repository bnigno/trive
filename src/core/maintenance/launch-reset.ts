// Limpeza pré-inauguração — PURO. A loja abre com o banco de produção cheio
// de teste (conversas, clientes, pedidos, reservas, fotos). A decisão da dona
// (2026-09-18): apagar tudo isso de verdade, manter catálogo, estoque de
// compras, fornecedores, configurações, modelos, usuários e motoboys; livro
// de estoque sem o rastro de pedido/reserva e saldo recalculado; primeiro
// pedido real #1001. Aqui mora o que é regra: a ordem em que o banco deixa
// apagar (filho antes do pai), quais gatilhos de proteção são desligados só
// dentro da transação, o que da fila/auditoria sobrevive, os baldes do
// recálculo, o que é "peça de teste" e quais arquivos do bucket saem.
import { LETTER_FINGERPRINT_KEY, parseEditionFingerprints } from "@/core/edition/fingerprint";
import { MOVEMENT_TYPES, movementAffects, type MovementType } from "@/core/stock/ledger";
import { WATCHDOG } from "@/core/whatsapp/watchdog";

/** A frase que o script exige em --confirmo=… para gravar. */
export const LAUNCH_RESET_CONFIRMATION = "LIMPAR-PRODUCAO";
/** O primeiro pedido real da loja. */
export const FIRST_REAL_ORDER_NUMBER = 1001;
export const ORDER_NUMBER_SEQUENCE = "orders_order_number_seq";

/**
 * Tabelas apagadas, na ordem em que o banco deixa (filho antes do pai —
 * as FKs são RESTRICT). Quatro delas são parciais: financial_entries (só as
 * de pedido), stock_movements (só order/hold), inbound_events (só zapi
 * velho) e audit_log (só as entidades apagadas).
 */
export const WIPE_STEPS = [
  "atelier_intakes",
  "wa_suggestions",
  "wa_followups",
  "delivery_feedback",
  "customer_looks",
  "stock_alerts",
  "stock_holds",
  "site_carts",
  "drop_waitlist",
  "drop_invites",
  "customer_profiles",
  "wa_messages",
  "wa_conversations",
  "delivery_positions",
  "delivery_stops",
  "delivery_runs",
  "financial_entries",
  "order_status_history",
  "order_items",
  "orders",
  "customer_addresses",
  "customers",
  "stock_movements",
  "outbox_events",
  "inbound_events",
  "audit_log",
] as const;
export type WipeStep = (typeof WIPE_STEPS)[number];

/** Pares (filho → pai) que a ordem acima tem de respeitar; o teste confere. */
export const WIPE_DEPENDENCIES: readonly (readonly [child: WipeStep, parent: WipeStep])[] = [
  ["atelier_intakes", "wa_messages"],
  ["atelier_intakes", "wa_conversations"],
  ["atelier_intakes", "financial_entries"],
  ["wa_suggestions", "wa_conversations"],
  ["wa_suggestions", "wa_followups"],
  ["wa_followups", "wa_conversations"],
  ["delivery_feedback", "orders"],
  ["wa_messages", "orders"],
  ["wa_messages", "wa_conversations"],
  ["delivery_positions", "delivery_runs"],
  ["delivery_stops", "delivery_runs"],
  ["delivery_stops", "orders"],
  ["financial_entries", "orders"],
  ["order_status_history", "orders"],
  ["order_items", "orders"],
  ["orders", "customers"],
  ["drop_invites", "customers"],
  ["customer_addresses", "customers"],
];

/**
 * Travadas em EXCLUSIVE antes de qualquer DELETE: bloqueia escrita e
 * SELECT … FOR UPDATE (o turno da Lia), não leitura — a vitrine continua
 * servindo; webhooks e crons esperam o commit e já veem o banco limpo.
 * A ORDEM é a em que a aplicação escreve (webhook: inbound_events →
 * wa_conversations → wa_messages → outbox → audit; checkout: customers →
 * orders → itens → estoque → outbox → audit): quem já está no meio de uma
 * transação termina sem cruzar com a limpeza (sem deadlock). A ordem dos
 * DELETEs (WIPE_STEPS) continua filho → pai. email_threads entra porque a
 * FK de customers a atualiza (SET NULL).
 */
export const LOCKED_TABLES: readonly string[] = [
  "inbound_events",
  "wa_conversations",
  "wa_messages",
  "wa_followups",
  "wa_suggestions",
  "atelier_intakes",
  "customers",
  "customer_addresses",
  "email_threads",
  "customer_profiles",
  "orders",
  "order_items",
  "order_status_history",
  "financial_entries",
  "stock_movements",
  "stock_levels",
  "stock_holds",
  "stock_alerts",
  "customer_looks",
  "site_carts",
  "drop_invites",
  "drop_waitlist",
  "delivery_runs",
  "delivery_stops",
  "delivery_positions",
  "delivery_feedback",
  "coupons",
  "products",
  "product_variants",
  "shipping_rates",
  "outbox_events",
  "audit_log",
];

/**
 * Gatilhos de proteção (drizzle/0002_fase1_guards.sql) desligados pelo nome,
 * só dentro da transação. Nunca DISABLE TRIGGER ALL nem
 * session_replication_role: exigem superusuário (passam no PGlite, falham
 * no Supabase).
 */
export const GUARD_TRIGGERS: readonly { table: string; trigger: string }[] = [
  { table: "orders", trigger: "orders_forbid_delete" },
  { table: "order_items", trigger: "order_items_forbid_delete" },
  { table: "order_status_history", trigger: "order_status_history_forbid_delete" },
  { table: "financial_entries", trigger: "financial_entries_forbid_delete" },
  { table: "stock_movements", trigger: "stock_movements_forbid_mutation" },
];

export function triggerToggleSql(guard: { table: string; trigger: string }, enable: boolean): string {
  return `ALTER TABLE "${guard.table}" ${enable ? "ENABLE" : "DISABLE"} TRIGGER "${guard.trigger}"`;
}

/** audit_log: entity_type de tudo que é apagado (produto, estoque, preço, usuário, faixa ficam). */
export const WIPED_AUDIT_ENTITY_TYPES: readonly string[] = [
  "order",
  "customer",
  "customer_address",
  "customer_profile",
  "customer_look",
  "wa_conversation",
  "wa_message",
  "wa_followup",
  "wa_suggestion",
  "stock_hold",
  "stock_alert",
  "delivery_run",
  "delivery_stop",
  "delivery_feedback",
  "atelier_intake",
  "site_cart",
  "drop_invite",
  "drop_waitlist",
];
/** Ações que guardam telefone numa entidade que fica (o lançamento): saem também. */
export const WIPED_AUDIT_ACTIONS: readonly string[] = ["drop.waitlist_join"];
/** Linhas de dedupe de alertas (1 h de carência): ficam, senão o alerta repete. */
export const KEPT_AUDIT_ACTIONS: readonly string[] = ["wa.watchdog_alert", "wa.session_alert", "system.function_failed_alert"];

/** outbox: agregados que deixam de existir. */
export const WIPED_OUTBOX_AGGREGATES: readonly string[] = [
  "order",
  "wa_conversation",
  "customer_look",
  "delivery_run",
  "stock_alert",
  "drop_waitlist",
  "atelier_intake",
];
export const OUTBOX_FINISHED_STATUSES: readonly string[] = ["done", "dead"];
/**
 * O que sai da fila: histórico (done/dead — a carga tem nome e telefone),
 * tudo sobre um agregado apagado, notificação do MP de pagamento de teste
 * (o pedido some; sem isso vira linha morta) e o convite VIP (`wa.*` com
 * agregado `drop`, alvo é uma cliente). Fica o que está por fazer de
 * produto, preço, lançamento, e-mail, resumo e o encaminhamento à dona.
 */
export function shouldDeleteOutboxRow(row: { status: string; aggregateType: string | null; eventType: string }): boolean {
  if (OUTBOX_FINISHED_STATUSES.includes(row.status)) return true;
  if (row.aggregateType && WIPED_OUTBOX_AGGREGATES.includes(row.aggregateType)) return true;
  if (row.eventType === "mp.payment_event") return true;
  return row.eventType.startsWith("wa.") && row.aggregateType === "drop";
}

/** Recebidos da Z-API: as últimas horas ficam (dedupe de reenvio); o resto sai. */
export const INBOUND_ZAPI_KEEP_HOURS = 24;

/** Livro de estoque: some tudo que nasceu de pedido ou reserva gentil. */
export const LEDGER_REFERENCE_TYPES_TO_DROP: readonly string[] = ["order", "hold"];
export const ON_HAND_MOVEMENT_TYPES: readonly MovementType[] = MOVEMENT_TYPES.filter((type) => movementAffects(type) === "onHand");
export const RESERVED_MOVEMENT_TYPES: readonly MovementType[] = MOVEMENT_TYPES.filter((type) => movementAffects(type) === "reserved");

export interface LedgerSum {
  productVariantId: string;
  type: MovementType;
  total: number;
}
export interface RecomputedLevel {
  productVariantId: string;
  onHand: number;
  reserved: number;
}

/** Saldo por variante = soma do livro por balde; variante conhecida sem movimento vira 0/0. */
export function recomputeLevels(sums: readonly LedgerSum[], knownVariantIds: readonly string[]): RecomputedLevel[] {
  const levels = new Map<string, RecomputedLevel>();
  const ensure = (id: string): RecomputedLevel => {
    let level = levels.get(id);
    if (!level) {
      level = { productVariantId: id, onHand: 0, reserved: 0 };
      levels.set(id, level);
    }
    return level;
  };
  for (const id of knownVariantIds) ensure(id);
  for (const sum of sums) {
    const level = ensure(sum.productVariantId);
    if (movementAffects(sum.type) === "reserved") level.reserved += sum.total;
    else level.onHand += sum.total;
  }
  return [...levels.values()];
}

export class LaunchResetInvariantError extends Error {
  constructor(readonly violations: readonly { sku: string; onHand: number; reserved: number }[]) {
    super(
      `Saldo recalculado inválido em ${violations.length} SKU(s): ${violations
        .map((v) => `${v.sku} (em mãos ${v.onHand}, reservado ${v.reserved})`)
        .join(", ")}. Nada foi gravado.`,
    );
    this.name = "LaunchResetInvariantError";
  }
}

/** Depois da limpeza só resta compra/ajuste/perda: reservado tem de ser 0 e em mãos ≥ 0. */
export function assertLevelInvariants(levels: readonly RecomputedLevel[], skuOf: (variantId: string) => string): void {
  const violations = levels
    .filter((level) => level.reserved !== 0 || level.onHand < 0)
    .map((level) => ({ sku: skuOf(level.productVariantId), onHand: level.onHand, reserved: level.reserved }));
  if (violations.length > 0) throw new LaunchResetInvariantError(violations);
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Peça de teste: "teste" como palavra no nome ou no SKU, ou SKU que começa com DEMO- ou TESTE-. */
export function isTestProduct(product: { name: string; skus: readonly string[] }): boolean {
  if (/\bteste\b/.test(fold(product.name))) return true;
  return product.skus.some((sku) => {
    const folded = fold(sku);
    return folded.startsWith("demo-") || folded.startsWith("teste-") || /\bteste\b/.test(folded);
  });
}

export function isTestShippingRate(rate: { name: string }): boolean {
  return /\bteste\b/.test(fold(rate.name));
}

/** Prefixos do bucket que a limpeza pode tocar; qualquer outro caminho é recusado. */
export const STORAGE_WIPE_PREFIXES: readonly string[] = ["receipts/", "packages/", "deliveries/", "gifts/", "editions/", "looks/", "atelier/"];

export function isWipeStoragePath(path: string): boolean {
  return STORAGE_WIPE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** A nomenclatura dos cartões da edição mora em services/edition-cards.ts; entra por aqui. */
export interface EditionPathNaming {
  card(orderId: string, productId: string): string;
  letter(orderId: string): string;
}

export function orderStoragePaths(
  order: {
    id: string;
    receiptPath: string | null;
    packagePhotoPath: string | null;
    deliveredPhotoPath: string | null;
    giftNotePath: string | null;
    editionCardsFingerprint: unknown;
  },
  naming: EditionPathNaming,
): string[] {
  const paths = [order.receiptPath, order.packagePhotoPath, order.deliveredPhotoPath, order.giftNotePath].filter(
    (path): path is string => Boolean(path),
  );
  const fingerprints = parseEditionFingerprints(order.editionCardsFingerprint);
  for (const key of Object.keys(fingerprints ?? {})) {
    paths.push(key === LETTER_FINGERPRINT_KEY ? naming.letter(order.id) : naming.card(order.id, key));
  }
  return paths;
}

export function lookStoragePaths(look: { photoPath: string | null; cardPath: string | null }): string[] {
  return [look.photoPath, look.cardPath].filter((path): path is string => Boolean(path));
}

export function intakeStoragePaths(intake: { cardPath: string | null }): string[] {
  return intake.cardPath ? [intake.cardPath] : [];
}

/**
 * O vigia compara os chats da Z-API com o que o sistema registrou; apagando
 * o registro, todo chat com movimento na janela dele viraria "buraco". Uma
 * linha `wa.watchdog_alert` por endereço ativo, datada de agora, diz ao
 * vigia "já avisado" — o que chegar depois da limpeza é registrado normalmente.
 */
export const WATCHDOG_SILENCE_WINDOW_MS = WATCHDOG.windowMs + WATCHDOG.toleranceMs;

export function watchdogSilenceRows(
  conversations: readonly {
    phoneE164: string;
    lid: string | null;
    /** Telefone do cadastro ligado: a Z-API pode listar pelo número real um chat que aqui nasceu só com LID. */
    customerPhoneE164?: string | null;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    updatedAt: Date;
  }[],
  now: Date,
): { address: string; lastMessageAt: Date }[] {
  const since = now.getTime() - WATCHDOG_SILENCE_WINDOW_MS;
  const addresses = new Set<string>();
  for (const conversation of conversations) {
    const stamps = [conversation.lastInboundAt, conversation.lastOutboundAt, conversation.updatedAt];
    if (!stamps.some((stamp) => stamp && stamp.getTime() > since)) continue;
    addresses.add(conversation.phoneE164);
    if (conversation.lid) addresses.add(conversation.lid);
    if (conversation.customerPhoneE164) addresses.add(conversation.customerPhoneE164);
  }
  return [...addresses].map((address) => ({ address, lastMessageAt: now }));
}

/** Host e banco para o log — a senha nunca sai (não usa new URL: senha com "@" quebra). */
export function describeDatabaseTarget(databaseUrl: string): { host: string; database: string } {
  const match = /^[a-z]+:\/\/(?:.*@)?([^:/?@]+)(?::\d+)?\/([^?]+)/i.exec(databaseUrl.trim());
  return { host: match?.[1] ?? "?", database: match?.[2] ?? "?" };
}
