// O handler de product.published / product.card_refresh com as dependências
// injetadas: "nada a desenhar" conclui sem enfileirar nada, estreia marcada
// reagenda para a data (chave única por tentativa), sucesso grava a prévia do
// link e revalida a página da peça — e uma revalidação que lança não derruba.
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import type { CardData } from "@/core/cards/types";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { RESCHEDULE_MIN_DELAY_MS, runProductCardsPrerender } from "@/queue/handlers/product-cards";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
const render = vi.fn(async (data: CardData) => {
  const { width, height } = data.kind === "story" ? { width: 108, height: 192 } : { width: 108, height: 135 };
  return sharp({ create: { width, height, channels: 3, background: "#faf7f0" } }).png().toBuffer();
});
const revalidate = vi.fn<(path: string) => void>();

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  render.mockClear();
  revalidate.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://trivemaison.com.br");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function activeProduct(opts: { photo?: boolean } = {}) {
  const { productId, variantId } = await createTestVariant(db, { sku: "HND-1", name: "Longo Dunas", onHand: 1 });
  await db.update(schema.products).set({ slug: "longo-dunas" }).where(eq(schema.products.id, productId));
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents: 28900,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 12000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
  if (opts.photo !== false) {
    const path = "products/dunas/1-full.webp";
    await db.insert(schema.productImages).values({ productId, storagePath: path, sortOrder: 0 });
    await storage.upload({
      path,
      data: await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#b08968" } }).webp().toBuffer(),
      contentType: "image/webp",
    });
  }
  return productId;
}

const deps = (now?: Date) => ({ db: sdb, storage, render, revalidate, ...(now ? { now: () => now } : {}) });
const event = (productId: string, id = "11111111-1111-4111-8111-111111111111") => ({
  id,
  eventType: "product.published",
  payload: { productId },
});
const published = async () =>
  db
    .select({ dedupeKey: schema.outboxEvents.dedupeKey, nextAttemptAt: schema.outboxEvents.nextAttemptAt })
    .from(schema.outboxEvents)
    .where(eq(schema.outboxEvents.eventType, "product.published"));

describe("runProductCardsPrerender", () => {
  it("desenha, grava a prévia do link e revalida a página da peça", async () => {
    const productId = await activeProduct();
    const result = await runProductCardsPrerender(deps(), event(productId));
    expect(result).toMatchObject({ skipped: null, slug: "longo-dunas", post: true, story: true });
    expect(revalidate).toHaveBeenCalledWith("/produto/longo-dunas");
    const [row] = await db.select({ path: schema.products.postCardPath }).from(schema.products).where(eq(schema.products.id, productId));
    expect(row.path).not.toBeNull();
    expect(await published()).toEqual([]);
  });

  it("sem foto: conclui sem desenhar, sem enfileirar e sem revalidar (não é falha)", async () => {
    const productId = await activeProduct({ photo: false });
    const result = await runProductCardsPrerender(deps(), event(productId));
    expect(result).toEqual({ skipped: "sem_foto", visibleFrom: null });
    expect(render).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(await published()).toEqual([]);
  });

  it("estreia marcada: reagenda para a data com chave única por tentativa; nunca antes de 60 s", async () => {
    const productId = await activeProduct();
    // prerenderProductPosts compara a estreia com o relógio REAL (Date.now());
    // só o reagendamento usa deps.now. Datas fixas viravam bomba-relógio
    // quando o calendário passava da estreia: aqui ela é sempre daqui a 8 dias.
    const DIA_MS = 24 * 60 * 60 * 1000;
    const estreia = new Date(Math.ceil(Date.now() / 1000) * 1000 + 8 * DIA_MS);
    const now = new Date(estreia.getTime() - 8 * DIA_MS - 60 * 60 * 1000);
    await db.update(schema.products).set({ visibleFrom: estreia }).where(eq(schema.products.id, productId));

    const first = await runProductCardsPrerender(deps(now), event(productId, "11111111-1111-4111-8111-111111111111"));
    expect(first.skipped).toBe("peca_agendada");
    let rows = await published();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(
      `product.published:${productId}:visible:${estreia.getTime()}:from:11111111-1111-4111-8111-111111111111`,
    );
    expect(rows[0].nextAttemptAt.getTime()).toBe(estreia.getTime());

    // Na hora, o relógio da função ainda vê a peça como agendada: outra olhada
    // em 60 s, com outra chave — nada é descartado como duplicado.
    const quase = new Date(estreia.getTime() - 1_000);
    const second = await runProductCardsPrerender(deps(quase), event(productId, "22222222-2222-4222-8222-222222222222"));
    expect(second.skipped).toBe("peca_agendada");
    rows = await published();
    expect(rows).toHaveLength(2);
    const retry = rows.find((row) => row.dedupeKey?.endsWith(":from:22222222-2222-4222-8222-222222222222"))!;
    expect(retry.nextAttemptAt.getTime()).toBe(quase.getTime() + RESCHEDULE_MIN_DELAY_MS);
    expect(render).not.toHaveBeenCalled();
  });

  it("revalidação que lança (fora do Next) não derruba o handler", async () => {
    const productId = await activeProduct();
    revalidate.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    await expect(runProductCardsPrerender(deps(), event(productId))).resolves.toMatchObject({ skipped: null });
  });
});
