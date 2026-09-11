// "Começar pela foto": as fotos viram um rascunho da ficha para a dona
// revisar. Nada entra no catálogo aqui — o que fica é o audit com o uso de
// tokens e o custo estimado.
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeSalesAssistant, FAKE_PRODUCT_DRAFT_JSON } from "@/adapters/assistant/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { draftProductFromPhotos, isCatalogDraftEnabled } from "@/services/product-draft";
import { ServiceError } from "@/services/settings";
import {
  createTestDb,
  createTestFeeRuleAndPolicy,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let assistant: FakeSalesAssistant;

async function photo(size = 2400): Promise<{ data: Buffer; contentType: string }> {
  const data = await sharp({
    create: { width: size, height: size, channels: 3, background: "#b08968" },
  })
    .jpeg()
    .toBuffer();
  return { data, contentType: "image/jpeg" };
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  assistant = new FakeSalesAssistant();
  vi.stubEnv("ADAPTER_MODE", "fake");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function auditRows() {
  return db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "product.draft_from_photos"));
}

describe("draftProductFromPhotos", () => {
  it("manda as fotos reduzidas e o prompt com manifesto, salas e cores conhecidas; devolve a ficha e audita o custo", async () => {
    await createTestFeeRuleAndPolicy(db);
    await db.insert(schema.settings).values([
      { key: "store_name", value: "TRIVÉ" },
      { key: "store_manifesto", value: "Curadoria para o calor de Belém." },
      { key: "bot_model", value: "claude-sonnet-5" },
    ]);
    await db.insert(schema.categories).values({ name: "Vestidos", slug: "vestidos" });

    const result = await draftProductFromPhotos(sdb, assistant, {
      photos: [await photo(), await photo()],
      costCents: 12000,
      userId: FIXED_USER_ID,
    });

    // Ficha revisável, com o que o modelo leu.
    expect(result.draft.name).toBe("Vestido Áurea");
    expect(result.draft.colors).toEqual(["Areia", "Terracota"]);
    expect(result.draft.sizes).toEqual(["P", "M", "G"]);
    expect(result.draft.composition).toBe("100% linho");
    expect(result.draft.careSymbols).toEqual(["hand_wash", "dry_shade"]);
    expect(result.draft.weightGrams).toBe(320);
    expect(result.draft.categoryId).toBeNull();

    // Preço sugerido pela política vigente (custo 12000, taxa 4,98%, margem 30%).
    expect(result.suggestedPrice?.priceCents).toBeGreaterThan(12000);
    expect(result.estimatedCostUsdCents).toBeGreaterThan(0);

    // O que o adapter recebeu: duas fotos reduzidas e o prompt da casa.
    const sent = assistant.extractions[0];
    expect(sent.images).toHaveLength(2);
    expect(sent.images[0].mediaType).toBe("image/jpeg");
    expect(sent.system).toContain("Curadoria para o calor de Belém.");
    expect(sent.system).toContain("- Vestidos (slug: vestidos)");
    expect(sent.model).toBe("claude-sonnet-5");
    expect(sent.jsonSchema).toMatchObject({ type: "object" });

    // As fotos chegam ao modelo REDUZIDAS (as originais tinham 2400 px).
    for (const image of sent.images) {
      const meta = await sharp(Buffer.from(image.base64, "base64")).metadata();
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024);
    }

    // Audit com uso e custo (é o único lugar onde o gasto existe); nada no catálogo.
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "user", actorId: FIXED_USER_ID, entityType: "product" });
    expect(audits[0].after).toMatchObject({
      ok: true,
      model: "claude-sonnet-5",
      photos: 2,
      name: "Vestido Áurea",
      usage: { inputTokens: 4200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
      estimatedCostUsdCents: 3,
      suggestedPriceCents: result.suggestedPrice?.priceCents ?? null,
    });
    expect(await db.select().from(schema.products)).toHaveLength(0);
  });

  it("resolve a sala pelo slug que o modelo devolveu", async () => {
    const [category] = await db
      .insert(schema.categories)
      .values({ name: "Vestidos", slug: "vestidos" })
      .returning({ id: schema.categories.id });
    assistant.enqueueExtraction({ ...FAKE_PRODUCT_DRAFT_JSON, categorySlug: "vestidos" });

    const result = await draftProductFromPhotos(sdb, assistant, {
      photos: [await photo()],
      costCents: 12000,
      userId: FIXED_USER_ID,
    });
    expect(result.draft.categoryId).toBe(category.id);
    expect(result.draft.categoryName).toBe("Vestidos");
  });

  it("sem política de preço o rascunho vem sem preço sugerido (e não quebra)", async () => {
    const result = await draftProductFromPhotos(sdb, assistant, {
      photos: [await photo()],
      costCents: 12000,
      userId: FIXED_USER_ID,
    });
    expect(result.suggestedPrice).toBeNull();
    expect(result.draft.name).toBe("Vestido Áurea");
  });

  it("IA fora do ar e JSON torto viram erro em pt-BR — e a tentativa É auditada (ela custou tokens)", async () => {
    const { AssistantUnavailableError } = await import("@/adapters/assistant");
    assistant.enqueueExtraction(new AssistantUnavailableError("Assistente de IA indisponível"));
    await expect(
      draftProductFromPhotos(sdb, assistant, {
        photos: [await photo()],
        costCents: 12000,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/Preencha a ficha à mão/);

    assistant.enqueueExtraction({ name: 42 });
    await expect(
      draftProductFromPhotos(sdb, assistant, {
        photos: [await photo()],
        costCents: 12000,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/formato esperado/);

    // O audit é o único lugar onde o gasto existe: a tentativa que falhou
    // entra com ok:false (e com o uso, quando a resposta chegou).
    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => (row.after as { reason?: string }).reason)).toEqual([
      "ia_indisponivel",
      "json_invalido",
    ]);
    expect((audits[1].after as { usage?: unknown }).usage).toBeDefined();
    expect(audits.every((row) => (row.after as { ok?: boolean }).ok === false)).toBe(true);
  });

  it("foto que o servidor não decodifica (HEIC) recusa antes de gastar a chamada, dizendo o que fazer", async () => {
    const naoEhFoto = { data: Buffer.from("isto não é uma imagem"), contentType: "image/heic" };
    await expect(
      draftProductFromPhotos(sdb, assistant, {
        photos: [naoEhFoto],
        costCents: 12000,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/Mais compatível/);
    expect(assistant.extractions).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("passa um sinal de cancelamento ao adapter (o estouro de tempo não deixa a chamada correndo)", async () => {
    await draftProductFromPhotos(sdb, assistant, {
      photos: [await photo()],
      costCents: 12000,
      userId: FIXED_USER_ID,
    });
    expect(assistant.extractions[0].signal).toBeInstanceOf(AbortSignal);
    expect(assistant.extractions[0].signal?.aborted).toBe(false);
  });

  it("interruptor desligado recusa; entrada inválida (sem foto, custo zero, 4 fotos) também", async () => {
    expect(await isCatalogDraftEnabled(sdb)).toBe(true);
    await db.insert(schema.settings).values({ key: "catalog_draft_enabled", value: false });
    expect(await isCatalogDraftEnabled(sdb)).toBe(false);
    await expect(
      draftProductFromPhotos(sdb, assistant, {
        photos: [await photo()],
        costCents: 12000,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ServiceError);

    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "catalog_draft_enabled"));
    const uma = await photo();
    await expect(
      draftProductFromPhotos(sdb, assistant, { photos: [], costCents: 12000, userId: FIXED_USER_ID }),
    ).rejects.toThrow();
    await expect(
      draftProductFromPhotos(sdb, assistant, { photos: [uma], costCents: 0, userId: FIXED_USER_ID }),
    ).rejects.toThrow();
    await expect(
      draftProductFromPhotos(sdb, assistant, {
        photos: [uma, uma, uma, uma],
        costCents: 12000,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow();
  });
});
