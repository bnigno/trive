// Integração do serviço de templates de WhatsApp com banco real (PGlite).
// Os templates são semeados inline (o seed de produção não roda nos testes).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
  listWaTemplates,
  ServiceError,
  updateWaTemplate,
} from "@/services/wa-templates";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.waTemplates).values([
    {
      key: "order_confirmed",
      label: "Pedido recebido",
      bodyTemplate: "Oi, {{nome}}! Recebemos seu pedido #{{pedido}}.",
      variables: ["nome", "pedido"],
      isActive: true,
    },
    {
      key: "owner_low_stock",
      label: "[interno] Estoque baixo",
      bodyTemplate: "Estoque baixo: {{produto}} (SKU {{sku}}).",
      variables: ["produto", "sku"],
      isActive: true,
    },
  ]);
});

afterAll(async () => {
  await close();
});

describe("listWaTemplates", () => {
  it("lista templates de cliente primeiro e internos (owner_) depois", async () => {
    const templates = await listWaTemplates(db);
    const keys = templates.map((t) => t.key);
    expect(keys).toEqual(["order_confirmed", "owner_low_stock"]);
    expect(templates[0]?.variables).toEqual(["nome", "pedido"]);
  });
});

describe("updateWaTemplate", () => {
  it("edita o corpo, recalcula variables e grava audit com before/after", async () => {
    const newBody =
      "Olá, {{cliente}}! Pedido #{{pedido}} de {{total}} confirmado. Veja: {{link}}";

    const updated = await updateWaTemplate(db, {
      key: "order_confirmed",
      bodyTemplate: newBody,
      isActive: false,
      userId: FIXED_USER_ID,
    });

    expect(updated.key).toBe("order_confirmed");
    expect(updated.bodyTemplate).toBe(newBody);
    // Variables SEMPRE recalculadas do corpo (na ordem de aparição, sem repetir).
    expect(updated.variables).toEqual(["cliente", "pedido", "total", "link"]);
    expect(updated.isActive).toBe(false);

    const [row] = await db
      .select()
      .from(schema.waTemplates)
      .where(eq(schema.waTemplates.key, "order_confirmed"));
    expect(row.bodyTemplate).toBe(newBody);
    expect(row.variables).toEqual(["cliente", "pedido", "total", "link"]);
    expect(row.isActive).toBe(false);

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "wa.template_update"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe("order_confirmed");
    expect(audits[0].actorId).toBe(FIXED_USER_ID);
    expect(audits[0].before).toMatchObject({
      bodyTemplate: "Oi, {{nome}}! Recebemos seu pedido #{{pedido}}.",
      isActive: true,
    });
    expect(audits[0].after).toMatchObject({
      bodyTemplate: newBody,
      variables: ["cliente", "pedido", "total", "link"],
      isActive: false,
    });
  });

  it("rejeita key inexistente com ServiceError (não cria templates novos)", async () => {
    await expect(
      updateWaTemplate(db, {
        key: "template_que_nao_existe",
        bodyTemplate: "Um corpo válido com mais de dez caracteres.",
        isActive: true,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);
    await expect(
      updateWaTemplate(db, {
        key: "template_que_nao_existe",
        bodyTemplate: "Um corpo válido com mais de dez caracteres.",
        isActive: true,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/desconhecido/i);

    const [created] = await db
      .select()
      .from(schema.waTemplates)
      .where(eq(schema.waTemplates.key, "template_que_nao_existe"));
    expect(created).toBeUndefined();
  });

  it("rejeita corpo com menos de 10 caracteres", async () => {
    await expect(
      updateWaTemplate(db, {
        key: "owner_low_stock",
        bodyTemplate: "curto",
        isActive: true,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/curto demais/i);

    // O template original permanece intacto.
    const [row] = await db
      .select()
      .from(schema.waTemplates)
      .where(eq(schema.waTemplates.key, "owner_low_stock"));
    expect(row.bodyTemplate).toBe("Estoque baixo: {{produto}} (SKU {{sku}}).");
  });
});
