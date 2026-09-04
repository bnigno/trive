// Ensaio "Testar a vendedora": roda um turno com o prompt real e as
// ferramentas em modo ensaio — nada persiste nem sai pela fila.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant } from "@/adapters/assistant/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { rehearseBotTurn } from "@/services/wa-rehearsal";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values({ key: "bot_seller_name", value: "Bia" });
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

describe("rehearseBotTurn", () => {
  it("devolve balões, anexos e ferramentas sem gravar nada", async () => {
    const { variantId } = await createTestVariant(db, {
      sku: "CANECA-AZUL",
      name: "Caneca Azul",
      onHand: 3,
    });
    await db.insert(schema.priceVersions).values({
      productVariantId: variantId,
      versionNumber: 1,
      status: "active",
      priceCents: 4990,
      origin: "initial",
      breakdown: {},
      costSnapshotCents: 1000,
      computedMarginRate: "0.3000",
      activatedAt: new Date(),
    });

    const assistant = new FakeSalesAssistant();
    assistant.enqueueScript({
      toolCalls: [
        { name: "listar_produtos", input: {} },
        { name: "avisar_dono", input: { mensagem: "teste" } },
      ],
      replyTemplate: "Olha o catálogo 👇\n---\nQual peça te chamou?",
    });

    const turn = await rehearseBotTurn(sdb, assistant, {
      history: [],
      message: "quero ver o catálogo",
    });

    expect(turn.sellerName).toBe("Bia");
    expect(turn.bubbles).toEqual(["Olha o catálogo 👇", "Qual peça te chamou?"]);
    expect(turn.attachments).toHaveLength(1);
    expect(turn.attachments[0].kind).toBe("option_list");
    expect(turn.toolCalls).toEqual([
      { name: "listar_produtos", ok: true },
      { name: "avisar_dono", ok: true },
    ]);
    // O prompt real chegou ao assistente, com o nome configurado.
    expect(assistant.turns).toHaveLength(1);

    // Ensaio: nenhuma conversa, mensagem ou evento de fila nasce.
    expect(await db.select().from(schema.waConversations)).toHaveLength(0);
    expect(await db.select().from(schema.waMessages)).toHaveLength(0);
    expect(await db.select().from(schema.outboxEvents)).toHaveLength(0);
  });

  it("recusa mensagem vazia", async () => {
    await expect(
      rehearseBotTurn(sdb, new FakeSalesAssistant(), { history: [], message: "  " }),
    ).rejects.toThrow();
  });
});
