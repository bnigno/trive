// Vendedora v3 (Onda 4): reserva gentil, liberação e "me avisa quando
// voltar" pelas ferramentas; o caderninho mostra a reserva e os avisos;
// no ensaio (dryRun) nada é gravado.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { assembleHistory, buildToolExecutor } from "@/services/wa-bot";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

const PHONE = "+5511999998888";
const CONVERSATION_ID = "00000000-0000-4000-8000-00000000c0de";

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.waConversations).values({ id: CONVERSATION_ID, phoneE164: PHONE, status: "open" });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function variant(sku: string, onHand: number) {
  const created = await createTestVariant(db, { sku, name: "Vestido Dunas", onHand });
  await db.update(schema.productVariants).set({ attributes: { cor: "Preto", tamanho: "M" } }).where(eq(schema.productVariants.id, created.variantId));
  await db.update(schema.products).set({ attributesSchema: ["cor", "tamanho"] }).where(eq(schema.products.id, created.productId));
  return created;
}

function executor(dryRun = false) {
  return buildToolExecutor(sdb, {
    conversationId: CONVERSATION_ID,
    phoneE164: PHONE,
    customerId: null,
    lastInboundId: "00000000-0000-4000-8000-00000000feed",
    ...(dryRun ? { dryRun: true } : {}),
  });
}

async function level(variantId: string) {
  const [row] = await db.select().from(schema.stockLevels).where(eq(schema.stockLevels.productVariantId, variantId));
  return { onHand: row.onHand, reserved: row.reserved };
}

describe("reservar_peca / liberar_reserva", () => {
  it("segura a combinação pelo SKU, devolve o prazo e reserva no ledger; a segunda é recusada", async () => {
    const { variantId } = await variant("DUNAS-PRET-M", 2);
    const execute = executor();
    const result = await execute("reservar_peca", { sku: "dunas-pret-m" });
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/Reserva feita: 1× Vestido Dunas \(Preto · M\) — guardada até \d{2}\/\d{2} às \d{2}:\d{2}/);
    expect(await level(variantId)).toEqual({ onHand: 2, reserved: 1 });

    const second = await execute("reservar_peca", { sku: "DUNAS-PRET-M", quantidade: 2 });
    expect(second.ok).toBe(false);
    expect(second.text).toContain("já tem uma reserva ativa");

    const released = await execute("liberar_reserva", {});
    expect(released.ok).toBe(true);
    expect(released.text).toContain("Reserva liberada");
    expect(await level(variantId)).toEqual({ onHand: 2, reserved: 0 });
    expect((await execute("liberar_reserva", {})).text).toContain("não tem reserva ativa");
  });

  it("SKU inexistente, mais de 2 unidades e peça esgotada são recusados com texto claro", async () => {
    await variant("ZERO", 0);
    const execute = executor();
    expect((await execute("reservar_peca", { sku: "NADA" })).ok).toBe(false);
    expect((await execute("reservar_peca", { sku: "ZERO", quantidade: 3 })).text).toContain("Dados inválidos");
    const soldOut = await execute("reservar_peca", { sku: "ZERO" });
    expect(soldOut.ok).toBe(false);
    expect(soldOut.text).toContain("não tem 1 disponível");
    expect(await db.select().from(schema.stockHolds)).toHaveLength(0);
  });

  it("no ensaio (dryRun) nada é gravado", async () => {
    await variant("DUNAS-PRET-M", 2);
    const execute = executor(true);
    expect((await execute("reservar_peca", { sku: "DUNAS-PRET-M" })).text).toContain("Ensaio");
    expect((await execute("avisar_quando_voltar", { sku: "DUNAS-PRET-M" })).text).toContain("Ensaio");
    expect(await db.select().from(schema.stockHolds)).toHaveLength(0);
    expect(await db.select().from(schema.stockAlerts)).toHaveLength(0);
  });
});

describe("avisar_quando_voltar + caderninho", () => {
  it("registra o aviso uma vez e o caderninho passa a mostrar reserva e avisos", async () => {
    const { variantId: soldOut } = await variant("DUNAS-PRET-P", 0);
    const { variantId: available } = await variant("DUNAS-PRET-M", 3);
    const execute = executor();
    const first = await execute("avisar_quando_voltar", { sku: "DUNAS-PRET-P" });
    expect(first.ok).toBe(true);
    expect(first.text).toContain("Aviso registrado para Vestido Dunas (Preto · M)");
    const again = await execute("avisar_quando_voltar", { sku: "DUNAS-PRET-P" });
    expect(again.text).toContain("já tinha pedido aviso");
    const alerts = await db.select().from(schema.stockAlerts);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ productVariantId: soldOut, phoneE164: PHONE, source: "lia", conversationId: CONVERSATION_ID });

    await execute("reservar_peca", { sku: "DUNAS-PRET-M" });
    expect(await level(available)).toEqual({ onHand: 3, reserved: 1 });

    // O caderninho (linhas extras) entra como primeira mensagem do histórico.
    const { getActiveHoldByPhone } = await import("@/services/stock-holds");
    const { listOpenAlertsByPhone } = await import("@/services/stock-alerts");
    const hold = await getActiveHoldByPhone(sdb, PHONE);
    const open = await listOpenAlertsByPhone(sdb, PHONE);
    const history = assembleHistory({}, [{ role: "user", text: "oi" }], {
      lines: [
        `Reserva ativa (gentil): ${hold?.description}`,
        `Avisos pedidos (quando voltar): ${open.map((a) => `${a.productName} (${a.variantLabel})`).join(", ")}`,
      ],
    });
    expect(history[0]?.text).toContain("CADERNINHO");
    expect(history[0]?.text).toContain("• Reserva ativa (gentil): 1× Vestido Dunas (Preto · M) — guardada até");
    expect(history[0]?.text).toContain("• Avisos pedidos (quando voltar): Vestido Dunas (Preto · M)");
  });
});
