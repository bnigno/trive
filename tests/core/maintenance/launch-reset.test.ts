import { describe, expect, it } from "vitest";

import {
  FIRST_REAL_ORDER_NUMBER,
  GUARD_TRIGGERS,
  INBOUND_ZAPI_KEEP_HOURS,
  KEPT_AUDIT_ACTIONS,
  LOCKED_TABLES,
  LaunchResetInvariantError,
  ON_HAND_MOVEMENT_TYPES,
  RESERVED_MOVEMENT_TYPES,
  STORAGE_WIPE_PREFIXES,
  WATCHDOG_SILENCE_WINDOW_MS,
  WIPED_AUDIT_ACTIONS,
  WIPE_DEPENDENCIES,
  WIPE_STEPS,
  assertLevelInvariants,
  describeDatabaseTarget,
  intakeStoragePaths,
  isTestProduct,
  isTestShippingRate,
  isWipeStoragePath,
  lookStoragePaths,
  orderStoragePaths,
  recomputeLevels,
  shouldDeleteOutboxRow,
  triggerToggleSql,
  watchdogSilenceRows,
} from "@/core/maintenance/launch-reset";
import { MOVEMENT_TYPES } from "@/core/stock/ledger";

const NAMING = {
  card: (orderId: string, productId: string) => `editions/${orderId}/${productId}.jpg`,
  letter: (orderId: string) => `editions/${orderId}/carta-de-estreia.jpg`,
};

describe("ordem da limpeza", () => {
  it("não repete tabela e apaga o filho antes do pai", () => {
    expect(new Set(WIPE_STEPS).size).toBe(WIPE_STEPS.length);
    for (const [child, parent] of WIPE_DEPENDENCIES) {
      expect(WIPE_STEPS.indexOf(child), `${child} antes de ${parent}`).toBeLessThan(WIPE_STEPS.indexOf(parent));
    }
  });

  it("trava tudo que apaga ou atualiza, na ordem em que a aplicação escreve (pai antes do filho)", () => {
    for (const step of WIPE_STEPS) expect(LOCKED_TABLES).toContain(step);
    for (const table of ["stock_levels", "coupons", "products", "product_variants", "shipping_rates", "email_threads"]) expect(LOCKED_TABLES).toContain(table);
    expect(new Set(LOCKED_TABLES).size).toBe(LOCKED_TABLES.length);
    const at = (t: string) => LOCKED_TABLES.indexOf(t);
    // webhook da Z-API: inbound → conversa → mensagem → fila → auditoria
    expect(at("inbound_events")).toBeLessThan(at("wa_conversations"));
    expect(at("wa_conversations")).toBeLessThan(at("wa_messages"));
    expect(at("wa_messages")).toBeLessThan(at("outbox_events"));
    expect(at("outbox_events")).toBeLessThan(at("audit_log"));
    // checkout: cliente → pedido → itens → estoque → fila
    expect(at("customers")).toBeLessThan(at("orders"));
    expect(at("orders")).toBeLessThan(at("order_items"));
    expect(at("order_items")).toBeLessThan(at("stock_movements"));
    expect(at("stock_movements")).toBeLessThan(at("stock_levels"));
    expect(at("stock_levels")).toBeLessThan(at("outbox_events"));
  });

  it("desliga exatamente os cinco gatilhos de proteção, pelo nome", () => {
    expect(GUARD_TRIGGERS.map((g) => g.trigger).sort()).toEqual([
      "financial_entries_forbid_delete",
      "order_items_forbid_delete",
      "order_status_history_forbid_delete",
      "orders_forbid_delete",
      "stock_movements_forbid_mutation",
    ]);
    expect(triggerToggleSql(GUARD_TRIGGERS[0], false)).toBe('ALTER TABLE "orders" DISABLE TRIGGER "orders_forbid_delete"');
    expect(triggerToggleSql(GUARD_TRIGGERS[4], true)).toBe('ALTER TABLE "stock_movements" ENABLE TRIGGER "stock_movements_forbid_mutation"');
    expect(GUARD_TRIGGERS.some((g) => g.trigger.toUpperCase().includes("ALL"))).toBe(false);
  });

  it("primeiro pedido real é o #1001 e a Z-API recente fica 24 h", () => {
    expect(FIRST_REAL_ORDER_NUMBER).toBe(1001);
    expect(INBOUND_ZAPI_KEEP_HOURS).toBe(24);
    expect(KEPT_AUDIT_ACTIONS).toContain("wa.watchdog_alert");
    expect(WIPED_AUDIT_ACTIONS).toContain("drop.waitlist_join");
  });
});

describe("shouldDeleteOutboxRow", () => {
  it("histórico e linhas mortas saem, seja de que agregado for", () => {
    expect(shouldDeleteOutboxRow({ status: "done", aggregateType: "product", eventType: "price.activated" })).toBe(true);
    expect(shouldDeleteOutboxRow({ status: "dead", aggregateType: null, eventType: "digest.daily" })).toBe(true);
  });

  it("o que está por fazer de produto, preço, lançamento e resumo fica — inclusive em retry", () => {
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: "price_version", eventType: "price.activated" })).toBe(false);
    expect(shouldDeleteOutboxRow({ status: "failed", aggregateType: "price_version", eventType: "price.activated" })).toBe(false);
    expect(shouldDeleteOutboxRow({ status: "processing", aggregateType: "product_variant", eventType: "stock.low" })).toBe(false);
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: "drop", eventType: "drop.published" })).toBe(false);
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: "digest", eventType: "digest.daily" })).toBe(false);
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: null, eventType: "wa.owner_forward" })).toBe(false);
  });

  it("tudo sobre gente apagada sai, mesmo pendente", () => {
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: "wa_conversation", eventType: "wa.bot_turn" })).toBe(true);
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: "order", eventType: "order.paid" })).toBe(true);
    expect(shouldDeleteOutboxRow({ status: "failed", aggregateType: "atelier_intake", eventType: "atelier.process" })).toBe(true);
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: "drop", eventType: "wa.drop_invite" })).toBe(true);
    expect(shouldDeleteOutboxRow({ status: "pending", aggregateType: null, eventType: "mp.payment_event" })).toBe(true);
  });
});

describe("recálculo do estoque", () => {
  it("os baldes cobrem todos os tipos, sem interseção", () => {
    expect([...ON_HAND_MOVEMENT_TYPES, ...RESERVED_MOVEMENT_TYPES].sort()).toEqual([...MOVEMENT_TYPES].sort());
    expect(RESERVED_MOVEMENT_TYPES).toEqual(["reservation", "reservation_release"]);
  });

  it("soma por balde e zera quem não tem movimento", () => {
    const levels = recomputeLevels(
      [
        { productVariantId: "v1", type: "purchase_in", total: 5 },
        { productVariantId: "v1", type: "loss", total: -1 },
        { productVariantId: "v2", type: "reservation", total: 2 },
      ],
      ["v1", "v3"],
    );
    expect(levels).toEqual([
      { productVariantId: "v1", onHand: 4, reserved: 0 },
      { productVariantId: "v3", onHand: 0, reserved: 0 },
      { productVariantId: "v2", onHand: 0, reserved: 2 },
    ]);
  });

  it("reservado diferente de zero ou em mãos negativo lançam listando o SKU", () => {
    const skuOf = (id: string) => `SKU-${id}`;
    expect(() => assertLevelInvariants([{ productVariantId: "v1", onHand: 4, reserved: 0 }], skuOf)).not.toThrow();
    expect(() =>
      assertLevelInvariants(
        [
          { productVariantId: "v1", onHand: 4, reserved: 0 },
          { productVariantId: "v2", onHand: 0, reserved: 2 },
          { productVariantId: "v3", onHand: -1, reserved: 0 },
        ],
        skuOf,
      ),
    ).toThrow(LaunchResetInvariantError);
    try {
      assertLevelInvariants([{ productVariantId: "v2", onHand: 0, reserved: 2 }], skuOf);
    } catch (error) {
      expect((error as LaunchResetInvariantError).violations).toEqual([{ sku: "SKU-v2", onHand: 0, reserved: 2 }]);
      expect((error as Error).message).toContain("SKU-v2");
      expect((error as Error).message).toContain("Nada foi gravado");
    }
  });
});

describe("peças e faixas de teste", () => {
  it("reconhece pelo nome ou pelo SKU, sem acento e sem caixa", () => {
    expect(isTestProduct({ name: "Pagamento de Teste", skus: ["TESTE-PAGAMENTO-1REAL"] })).toBe(true);
    expect(isTestProduct({ name: "Vestido teste", skus: ["X-1"] })).toBe(true);
    expect(isTestProduct({ name: "Longo Dunas", skus: ["DEMO-01"] })).toBe(true);
    expect(isTestProduct({ name: "Peça", skus: ["LD-P", "teste-2"] })).toBe(true);
    expect(isTestProduct({ name: "TÉSTE", skus: [] })).toBe(true);
  });

  it("não confunde palavra parecida nem peça real", () => {
    expect(isTestProduct({ name: "Longo Dunas", skus: ["LD-P"] })).toBe(false);
    expect(isTestProduct({ name: "Contestei", skus: ["CONTESTE-1"] })).toBe(false);
    expect(isTestProduct({ name: "Demonstração de fé", skus: ["DEMONSTRA-1"] })).toBe(false);
    expect(isTestShippingRate({ name: "Frete grátis (teste de pagamento)" })).toBe(true);
    expect(isTestShippingRate({ name: "Motoboy Belém" })).toBe(false);
  });
});

describe("arquivos do bucket", () => {
  it("junta as quatro fotos do pedido com os cartões da edição pela impressão digital", () => {
    const paths = orderStoragePaths(
      {
        id: "o1",
        receiptPath: "receipts/o1/comprovante.jpg",
        packagePhotoPath: "packages/o1/embalagem.jpg",
        deliveredPhotoPath: null,
        giftNotePath: "gifts/o1/bilhete.jpg",
        editionCardsFingerprint: { p1: "h1", carta: "h2" },
      },
      NAMING,
    );
    expect(paths).toEqual([
      "receipts/o1/comprovante.jpg",
      "packages/o1/embalagem.jpg",
      "gifts/o1/bilhete.jpg",
      "editions/o1/p1.jpg",
      "editions/o1/carta-de-estreia.jpg",
    ]);
    expect(orderStoragePaths({ id: "o2", receiptPath: null, packagePhotoPath: null, deliveredPhotoPath: null, giftNotePath: null, editionCardsFingerprint: "lixo" }, NAMING)).toEqual([]);
    expect(lookStoragePaths({ photoPath: "looks/l1/photo.jpg", cardPath: null })).toEqual(["looks/l1/photo.jpg"]);
    expect(intakeStoragePaths({ cardPath: null })).toEqual([]);
    expect(intakeStoragePaths({ cardPath: "atelier/i1/card-1.jpg" })).toEqual(["atelier/i1/card-1.jpg"]);
  });

  it("só toca nos prefixos da limpeza — nunca em foto de produto", () => {
    for (const prefix of STORAGE_WIPE_PREFIXES) expect(isWipeStoragePath(`${prefix}x/y.jpg`)).toBe(true);
    expect(isWipeStoragePath("products/p1/a-full.webp")).toBe(false);
    expect(isWipeStoragePath("cards/ab/key.jpg")).toBe(false);
    expect(isWipeStoragePath("digests/2026-09-18.jpg")).toBe(false);
    expect(isWipeStoragePath("")).toBe(false);
  });
});

describe("silêncio do vigia", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  it("cobre telefone, LID e o telefone do cadastro de quem teve movimento na janela do vigia", () => {
    const recent = new Date(now.getTime() - 60 * 60_000);
    const old = new Date(now.getTime() - WATCHDOG_SILENCE_WINDOW_MS - 60_000);
    const rows = watchdogSilenceRows(
      [
        { phoneE164: "+5591988887777", lid: "123@lid", lastInboundAt: recent, lastOutboundAt: null, updatedAt: old },
        { phoneE164: "+5591911112222", lid: null, lastInboundAt: null, lastOutboundAt: null, updatedAt: recent },
        { phoneE164: "456@lid", lid: "456@lid", customerPhoneE164: "+5591955556666", lastInboundAt: recent, lastOutboundAt: null, updatedAt: recent },
        { phoneE164: "+5591933334444", lid: "999@lid", customerPhoneE164: "+5591900001111", lastInboundAt: old, lastOutboundAt: old, updatedAt: old },
      ],
      now,
    );
    expect(rows.map((r) => r.address).sort()).toEqual(["+5591911112222", "+5591955556666", "+5591988887777", "123@lid", "456@lid"]);
    expect(rows.every((r) => r.lastMessageAt === now)).toBe(true);
  });
});

describe("describeDatabaseTarget", () => {
  it("mostra host e banco, nunca a senha", () => {
    const url = "postgresql://postgres.abc:Se.nh@@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require";
    const target = describeDatabaseTarget(url);
    expect(target).toEqual({ host: "aws-0-sa-east-1.pooler.supabase.com", database: "postgres" });
    expect(JSON.stringify(target)).not.toContain("Se.nh");
    expect(describeDatabaseTarget("postgres://postgres@127.0.0.1:5432/trive_dev")).toEqual({ host: "127.0.0.1", database: "trive_dev" });
    expect(describeDatabaseTarget("lixo")).toEqual({ host: "?", database: "?" });
  });
});
