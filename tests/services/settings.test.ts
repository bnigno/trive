// Integração do serviço de configurações com banco real (PGlite + migrações).
// Referência das fixtures: custo 1000, taxa 4,98%, margem 30%, to_90 up
// => preço 1690. Com taxa 20%: 1000 / (1 - 0.2 - 0.3) = 2000 -> to_90 up = 2090.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import {
  getDefaultPolicy,
  getFeeRules,
  getSettingsMap,
  replaceFeeRule,
  ServiceError,
  updateDefaultPolicy,
  updateSetting,
} from "@/services/settings";
import { previewPrice } from "@/services/pricing";
import {
  createTestDb,
  createTestFeeRuleAndPolicy,
  createTestVariant,
  FIXED_USER_ID,
  type TestDb,
} from "../helpers/db";

let db: TestDb;
let close: () => Promise<void>;
let originalFeeRuleId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ feeRuleId: originalFeeRuleId } = await createTestFeeRuleAndPolicy(db));
});

afterAll(async () => {
  await close();
});

describe("replaceFeeRule", () => {
  it("encerra a vigência da regra atual e o novo cálculo usa a nova taxa", async () => {
    const { variantId } = await createTestVariant(db, { costCents: 1000 });

    const before = await previewPrice(db, { variantId });
    expect(before.result.priceCents).toBe(1690);
    expect(before.context.feeRuleId).toBe(originalFeeRuleId);

    const created = await replaceFeeRule(db, {
      paymentMethod: "credit_card",
      percentRate: 0.2,
      fixedFeeCents: 50,
      settlementDays: 14,
      userId: FIXED_USER_ID,
    });

    // Nova regra vigente, herdando a marcação de referência da substituída.
    expect(created.id).not.toBe(originalFeeRuleId);
    expect(created.percentRate).toBe(0.2);
    expect(created.fixedFeeCents).toBe(50);
    expect(created.settlementDays).toBe(14);
    expect(created.isReferenceForPricing).toBe(true);
    expect(created.effectiveTo).toBeNull();

    // Regra antiga: vigência encerrada (effective_to preenchido), não editada.
    const [old] = await db
      .select()
      .from(schema.paymentFeeRules)
      .where(eq(schema.paymentFeeRules.id, originalFeeRuleId));
    expect(old.effectiveTo).not.toBeNull();
    expect(Number(old.percentRate)).toBe(0.0498);

    const { current, history } = await getFeeRules(db);
    expect(current.map((r) => r.id)).toContain(created.id);
    expect(current.map((r) => r.id)).not.toContain(originalFeeRuleId);
    expect(history.map((r) => r.id)).toContain(originalFeeRuleId);

    // Novo cálculo usa a nova taxa: (1000 + 50) / (1 - 0.2 - 0.3) = 2100
    // -> to_90 up = 2190.
    const after = await previewPrice(db, { variantId });
    expect(after.context.feeRuleId).toBe(created.id);
    expect(after.result.priceCents).toBe(2190);

    // Audit da substituição.
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.entityId, created.id));
    expect(audits.map((a) => a.action)).toContain("feerule.replace");
  });

  it("marcar outra regra como referência desmarca a anterior", async () => {
    const pixRule = await replaceFeeRule(db, {
      paymentMethod: "pix",
      percentRate: 0.0099,
      fixedFeeCents: 0,
      settlementDays: 0,
      isReferenceForPricing: true,
      userId: FIXED_USER_ID,
    });

    const { current } = await getFeeRules(db);
    const references = current.filter((r) => r.isReferenceForPricing);
    expect(references).toHaveLength(1);
    expect(references[0].id).toBe(pixRule.id);
  });
});

describe("getDefaultPolicy / updateDefaultPolicy", () => {
  it("atualiza a política global e valida margem mínima <= alvo", async () => {
    const updated = await updateDefaultPolicy(db, {
      targetMarginRate: 0.35,
      minMarginRate: 0.1,
      roundingMode: "to_99",
      roundingDirection: "nearest",
      otherCostsFixedCents: 250,
      userId: FIXED_USER_ID,
    });
    expect(updated.targetMarginRate).toBe(0.35);
    expect(updated.otherCostsFixedCents).toBe(250);

    const fetched = await getDefaultPolicy(db);
    expect(fetched?.id).toBe(updated.id);
    expect(fetched?.minMarginRate).toBe(0.1);
    expect(fetched?.roundingMode).toBe("to_99");
    expect(fetched?.roundingDirection).toBe("nearest");

    await expect(
      updateDefaultPolicy(db, {
        targetMarginRate: 0.2,
        minMarginRate: 0.3,
        roundingMode: "to_90",
        roundingDirection: "up",
        otherCostsFixedCents: 0,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("A margem mínima não pode ser maior que a margem alvo.");
  });
});

describe("updateSetting / getSettingsMap", () => {
  it("a carta de estreia aceita até 900 caracteres e a assinatura até 60; vazio desliga", async () => {
    await updateSetting(db, { key: "debut_letter_text", value: "Bem-vinda à maison.", userId: FIXED_USER_ID });
    await updateSetting(db, { key: "debut_letter_signature", value: "Marina", userId: FIXED_USER_ID });
    expect(await getSettingsMap(db, ["debut_letter_text", "debut_letter_signature"])).toEqual({
      debut_letter_text: "Bem-vinda à maison.",
      debut_letter_signature: "Marina",
    });
    await expect(
      updateSetting(db, { key: "debut_letter_text", value: "palavra ".repeat(120), userId: FIXED_USER_ID }),
    ).rejects.toThrow(/900/);
    // Quebras do navegador (CRLF) não contam duas vezes: 12 linhas curtas com \r\n passam e ficam com \n.
    const crlf = Array.from({ length: 12 }, (_, i) => `Linha ${i + 1} da carta, curta.`).join("\r\n");
    await updateSetting(db, { key: "debut_letter_text", value: crlf, userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["debut_letter_text"])).debut_letter_text).toBe(crlf.replace(/\r\n/g, "\n"));
    // Mais de 12 linhas, ou um texto que não cabe no papel nem na letra menor, é recusado com a razão — nunca cortado em silêncio.
    await expect(
      updateSetting(db, { key: "debut_letter_text", value: Array.from({ length: 13 }, () => "linha").join("\n"), userId: FIXED_USER_ID }),
    ).rejects.toThrow(/13 linhas/);
    await expect(
      updateSetting(db, {
        key: "debut_letter_text",
        value: Array.from({ length: 10 }, () => "PALAVRA COMPRIDA ".repeat(5).trim()).join("\n"),
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/não cabe no papel/);
    await expect(
      updateSetting(db, { key: "debut_letter_signature", value: "x".repeat(61), userId: FIXED_USER_ID }),
    ).rejects.toThrow(/60/);
    // 60 caracteres em caixa alta não cabem numa linha: recusa com a razão, em vez de imprimir cortado.
    await expect(
      updateSetting(db, { key: "debut_letter_signature", value: "MARINA DA SILVA, CURADORA DA TRIVÉ MAISON EM BELÉM DO PARÁ", userId: FIXED_USER_ID }),
    ).rejects.toThrow(/não cabe numa linha/);
    await updateSetting(db, { key: "debut_letter_text", value: "   ", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["debut_letter_text"])).debut_letter_text).toBe("");
  });

  it("trocar a edição (ou o nome da loja) pede a atualização do cartão de cada peça ativa, escalonada", async () => {
    const a = await createTestVariant(db, { sku: "ED-A" });
    const b = await createTestVariant(db, { sku: "ED-B" });
    const rascunho = await createTestVariant(db, { sku: "ED-C" });
    await db.update(schema.products).set({ status: "draft" }).where(eq(schema.products.id, rascunho.productId));
    const refreshes = async () =>
      db
        .select({ aggregateId: schema.outboxEvents.aggregateId, nextAttemptAt: schema.outboxEvents.nextAttemptAt })
        .from(schema.outboxEvents)
        .where(and(eq(schema.outboxEvents.eventType, "product.card_refresh"), eq(schema.outboxEvents.status, "pending")))
        .orderBy(schema.outboxEvents.nextAttemptAt);

    await updateSetting(db, { key: "edition_name", value: "Edição Círio", userId: FIXED_USER_ID });
    const events = await refreshes();
    const ids = events.map((row) => row.aggregateId);
    // Uma vez por peça ativa (o banco deste arquivo é compartilhado: pode haver outras ativas).
    expect(ids.filter((id) => id === a.productId)).toHaveLength(1);
    expect(ids.filter((id) => id === b.productId)).toHaveLength(1);
    expect(ids).not.toContain(rascunho.productId);
    // Uma de cada vez: 20 s entre uma peça e a seguinte.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].nextAttemptAt.getTime() - events[i - 1].nextAttemptAt.getTime()).toBe(20_000);
    }

    // Mesmo valor de novo: nada mudou no cartão, nada enfileira.
    const before = events.length;
    await updateSetting(db, { key: "edition_name", value: "Edição Círio", userId: FIXED_USER_ID });
    expect(await refreshes()).toHaveLength(before);
    // Outra configuração qualquer não mexe em cartão.
    await updateSetting(db, { key: "first_price_requires_approval", value: false, userId: FIXED_USER_ID });
    expect(await refreshes()).toHaveLength(before);
    // O nome da loja também está na faixa — mas o refresh já marcado para cada
    // peça (ainda longe de vencer) cobre a mudança: nada novo entra.
    await updateSetting(db, { key: "store_name", value: "TRIVÉ Maison", userId: FIXED_USER_ID });
    expect(await refreshes()).toHaveLength(before);
    // Com a fila limpa, o nome da loja enfileira um por peça ativa.
    await db.update(schema.outboxEvents).set({ status: "done" }).where(eq(schema.outboxEvents.eventType, "product.card_refresh"));
    await updateSetting(db, { key: "store_name", value: "TRIVÉ Maison Belém", userId: FIXED_USER_ID });
    const byStoreName = (await refreshes()).filter((row) => row.aggregateId === a.productId || row.aggregateId === b.productId);
    expect(byStoreName).toHaveLength(2);
  });

  it("store_instagram normaliza para '@usuario' (aceita @, URL do perfil, caixa alta); vazio desliga; inválido rejeita", async () => {
    await updateSetting(db, { key: "store_instagram", value: "  @Trive_MFeminine ", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_instagram"])).store_instagram).toBe("@trive_mfeminine");
    await updateSetting(db, { key: "store_instagram", value: "https://www.instagram.com/trive_mfeminine/?hl=pt", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_instagram"])).store_instagram).toBe("@trive_mfeminine");
    // Sem esquema e o link "Compartilhar perfil" do app (sem barra antes do ?): nunca vira '@instagram.com'.
    await updateSetting(db, { key: "store_instagram", value: "www.instagram.com/trive_mfeminine", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_instagram"])).store_instagram).toBe("@trive_mfeminine");
    await updateSetting(db, { key: "store_instagram", value: "https://www.instagram.com/trive_mfeminine?igsh=MTIzNDU2", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_instagram"])).store_instagram).toBe("@trive_mfeminine");
    await updateSetting(db, { key: "store_instagram", value: "", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_instagram"])).store_instagram).toBe("");
    await expect(updateSetting(db, { key: "store_instagram", value: "trivé maison", userId: FIXED_USER_ID })).rejects.toThrow(/Instagram inválido/);
  });

  it("Correios automático: store_cep grava com hífen (o jsonb só de dígitos viraria número), vazio desliga, 7 dígitos rejeita; acréscimo é inteiro 0..10000; toggle é boolean", async () => {
    await updateSetting(db, { key: "store_cep", value: " 66045335 ", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_cep"])).store_cep).toBe("66045-335");
    await updateSetting(db, { key: "store_cep", value: "01310-100", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_cep"])).store_cep).toBe("01310-100");
    await updateSetting(db, { key: "store_cep", value: "", userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["store_cep"])).store_cep).toBe("");
    await expect(updateSetting(db, { key: "store_cep", value: "6604533", userId: FIXED_USER_ID })).rejects.toThrow(/CEP inválido/);

    await updateSetting(db, { key: "correios_surcharge_cents", value: 300, userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["correios_surcharge_cents"])).correios_surcharge_cents).toBe(300);
    await expect(updateSetting(db, { key: "correios_surcharge_cents", value: 3.5, userId: FIXED_USER_ID })).rejects.toThrow(ServiceError);
    await expect(updateSetting(db, { key: "correios_surcharge_cents", value: -1, userId: FIXED_USER_ID })).rejects.toThrow(/negativo/);
    await expect(updateSetting(db, { key: "correios_surcharge_cents", value: 10_001, userId: FIXED_USER_ID })).rejects.toThrow(/R\$ 100,00/);

    await updateSetting(db, { key: "correios_auto_enabled", value: true, userId: FIXED_USER_ID });
    expect((await getSettingsMap(db, ["correios_auto_enabled"])).correios_auto_enabled).toBe(true);
    await expect(updateSetting(db, { key: "correios_auto_enabled", value: "sim", userId: FIXED_USER_ID })).rejects.toThrow(ServiceError);
  });

  it("rejeita key desconhecida com ServiceError", async () => {
    await expect(
      updateSetting(db, {
        key: "chave_que_nao_existe",
        value: 1,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);
    await expect(
      updateSetting(db, {
        key: "chave_que_nao_existe",
        value: 1,
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/desconhecida/i);
  });

  it("rejeita valor com tipo errado para uma key permitida", async () => {
    await expect(
      updateSetting(db, {
        key: "first_price_requires_approval",
        value: "sim",
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(ServiceError);
  });

  it("atualiza key permitida e reflete no getSettingsMap", async () => {
    await updateSetting(db, {
      key: "price_change_pct_threshold",
      value: 0.25,
      userId: FIXED_USER_ID,
    });
    await updateSetting(db, {
      key: "default_low_stock_threshold",
      value: 7,
      userId: FIXED_USER_ID,
    });

    const map = await getSettingsMap(db, [
      "price_change_pct_threshold",
      "default_low_stock_threshold",
    ]);
    expect(map.price_change_pct_threshold).toBe(0.25);
    expect(map.default_low_stock_threshold).toBe(7);
  });

  it("handoff_silence_hours (1–168) e handoff_auto_return_hours (0–168): inteiros na faixa; fora dela rejeita", async () => {
    await updateSetting(db, { key: "handoff_silence_hours", value: 2, userId: FIXED_USER_ID });
    await updateSetting(db, { key: "handoff_auto_return_hours", value: 0, userId: FIXED_USER_ID });
    const map = await getSettingsMap(db, ["handoff_silence_hours", "handoff_auto_return_hours"]);
    expect(map.handoff_silence_hours).toBe(2);
    expect(map.handoff_auto_return_hours).toBe(0);
    for (const bad of [{ key: "handoff_silence_hours", value: 0 }, { key: "handoff_silence_hours", value: 169 }, { key: "handoff_silence_hours", value: 1.5 }, { key: "handoff_auto_return_hours", value: -1 }, { key: "handoff_auto_return_hours", value: 200 }, { key: "handoff_auto_return_hours", value: "12" }]) {
      await expect(updateSetting(db, { ...bad, userId: FIXED_USER_ID })).rejects.toThrow(ServiceError);
    }
  });

  it("store_pix_key: aparas espaços, aceita vazia (= desligado) e limita a 140", async () => {
    const saved = await updateSetting(db, {
      key: "store_pix_key",
      value: "  pix@trive.com.br  ",
      userId: FIXED_USER_ID,
    });
    expect(saved.value).toBe("pix@trive.com.br");

    const map = await getSettingsMap(db, ["store_pix_key"]);
    expect(map.store_pix_key).toBe("pix@trive.com.br");

    // Vazia desliga o recurso (o robô responde indisponível) — permitida.
    const cleared = await updateSetting(db, {
      key: "store_pix_key",
      value: "",
      userId: FIXED_USER_ID,
    });
    expect(cleared.value).toBe("");

    await expect(
      updateSetting(db, {
        key: "store_pix_key",
        value: "x".repeat(141),
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow(/140/);
  });
});

describe("replaceFeeRule — métodos manuais (pix_manual/cash)", () => {
  it("aceita os métodos novos do core (dono edita a taxa dos 5)", async () => {
    const cash = await replaceFeeRule(db, {
      paymentMethod: "cash",
      percentRate: 0,
      fixedFeeCents: 0,
      settlementDays: 0,
      userId: FIXED_USER_ID,
    });
    expect(cash.paymentMethod).toBe("cash");
    expect(cash.percentRate).toBe(0);

    const pixManual = await replaceFeeRule(db, {
      paymentMethod: "pix_manual",
      percentRate: 0,
      fixedFeeCents: 0,
      settlementDays: 0,
      userId: FIXED_USER_ID,
    });
    expect(pixManual.paymentMethod).toBe("pix_manual");
  });
});

describe("store_tagline / store_manifesto (textos da vitrine)", () => {
  it("apara espaços, aceita vazio (= texto padrão) e limita o tamanho", async () => {
    await updateSetting(db, {
      key: "store_tagline",
      value: "  Para a mulher que se veste de si.  ",
      userId: FIXED_USER_ID,
    });
    await updateSetting(db, {
      key: "store_manifesto",
      value: "",
      userId: FIXED_USER_ID,
    });
    const map = await getSettingsMap(db, ["store_tagline", "store_manifesto"]);
    expect(map.store_tagline).toBe("Para a mulher que se veste de si.");
    expect(map.store_manifesto).toBe("");

    await expect(
      updateSetting(db, {
        key: "store_tagline",
        value: "x".repeat(141),
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("no máximo 140");
    await expect(
      updateSetting(db, {
        key: "store_manifesto",
        value: "x".repeat(601),
        userId: FIXED_USER_ID,
      }),
    ).rejects.toThrow("no máximo 600");
  });
});
