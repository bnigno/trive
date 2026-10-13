// "Me vê com ela" no banco: a tabela dos pedidos de prévia não tem coluna de
// imagem, recusa estado desconhecido, segura uma prévia por conversa de cada
// vez e um pedido da FASHN por linha; os settings nascem desligados.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialSettings } from "@/db/seed-data";
import * as schema from "@/db/schema";
import { ALLOWED_SETTING_KEYS } from "@/services/settings";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function seed() {
  const [product] = await db.insert(schema.products).values({ name: "P", slug: "p", status: "active" }).returning({ id: schema.products.id });
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591988887777" }).returning({ id: schema.waConversations.id });
  return { productId: product!.id, conversationId: conversation!.id, phoneE164: "+5591988887777" };
}

describe("tryon_requests", () => {
  it("não tem coluna de imagem (nada é guardado) e tem RLS ligado", async () => {
    const columns = await db.execute(sql`select column_name from information_schema.columns where table_name = 'tryon_requests'`);
    const names = (columns as unknown as { rows: { column_name: string }[] }).rows.map((row) => row.column_name);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => /url|path|image|bytes|base64/.test(name))).toEqual([]);
    const rls = await db.execute(sql`select rowsecurity from pg_tables where tablename = 'tryon_requests'`);
    expect((rls as unknown as { rows: { rowsecurity: boolean }[] }).rows[0]?.rowsecurity).toBe(true);
  });

  it("recusa estado desconhecido e mais de 2 envios à FASHN", async () => {
    const base = await seed();
    await expect(db.insert(schema.tryonRequests).values({ ...base, status: "done" })).rejects.toThrow();
    await expect(db.insert(schema.tryonRequests).values({ ...base, attempts: 3 })).rejects.toThrow();
  });

  it("uma prévia sendo feita por conversa; um pedido da FASHN = uma linha", async () => {
    const base = await seed();
    await db.insert(schema.tryonRequests).values({ ...base, status: "queued", vendorJobId: "job-1" });
    await expect(db.insert(schema.tryonRequests).values({ ...base, status: "processing" })).rejects.toThrow();
    // Encerradas e ofertas não contam como "sendo feita".
    await db.insert(schema.tryonRequests).values([{ ...base, status: "sent" }, { ...base, status: "offered" }]);
    await expect(db.insert(schema.tryonRequests).values({ ...base, status: "sent", vendorJobId: "job-1" })).rejects.toThrow();
  });

  it("settings: semeados desligados, com os tetos padrão, dentro das chaves permitidas", () => {
    const seeded = Object.fromEntries(initialSettings.map((setting) => [setting.key, setting.value]));
    expect(seeded["tryon_enabled"]).toBe(false);
    expect(seeded["tryon_per_customer_daily"]).toBe(2);
    expect(seeded["tryon_daily_total"]).toBe(20);
    for (const key of ["tryon_enabled", "tryon_per_customer_daily", "tryon_daily_total"]) expect(ALLOWED_SETTING_KEYS).toContain(key);
  });
});
