// A porta de entrada do Provador pela Lia (PGlite + fakes): sem cartela
// recusa e diz o que falta; com cartela e sim, nasce o cadastro (ou o opt-in
// do existente, auditado) e a LOJA manda o cartão com o link pela fila; quem
// já está na sala não recebe de novo; número oculto não entra; no ensaio nada
// acontece; o sync marca "pela Lia" quem entrou depois do convite.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupMetadata } from "@/adapters/zapi";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { buildToolExecutor } from "@/services/wa-bot";
import { listGroupMembers, provadorEntryMessage, provadorEntryUrl, registerGroup, syncGroupMembers } from "@/services/wa-groups";
import { createTestDb, FIXED_USER_ID, type TestDb } from "../helpers/db";

const kicks: unknown[] = [];
vi.mock("@/inngest/client", () => ({ inngest: { send: async (event: unknown) => { kicks.push(event); return { ids: [] }; } } }));

const GROUP = "120363019502650977-group";
const ANA = "+5591999990001";
const NOW = new Date("2026-09-22T13:00:00Z");

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;

const metadata = (participants: GroupMetadata["participants"]): GroupMetadata => ({
  groupId: GROUP,
  name: "Provador TRIVÉ",
  description: null,
  ownerE164: "+5591981037536",
  invitationLink: "https://chat.whatsapp.com/convite",
  adminOnlyMessage: false,
  adminOnlySettings: true,
  requireAdminApproval: false,
  participants,
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "groups_enabled", value: true },
    { key: "bot_seller_name", value: "Lia" },
    { key: "store_name", value: "TRIVÉ" },
    { key: "store_whatsapp", value: "(91) 98103-7536" },
  ]);
  provider.setGroup(metadata([{ phoneE164: "+5591981037536", lid: null, isAdmin: true }]));
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function conversation(phoneE164 = ANA, displayName?: string): Promise<string> {
  const [row] = await db
    .insert(schema.waConversations)
    .values({ phoneE164, status: "open", botState: displayName ? { displayName } : {} })
    .returning({ id: schema.waConversations.id });
  return row.id;
}

async function cartela(phoneE164: string) {
  await db.insert(schema.customerProfiles).values({
    phoneE164,
    profile: { sizes: { vestido: "M" }, colorsLove: ["terracota"], colorsAvoid: [], fit: "tanto_faz", occasions: [], buysFor: "mim" },
    source: "lia",
    consentAt: NOW,
  });
}

function executor(conversationId: string, phoneE164 = ANA, extra: { dryRun?: boolean; customerId?: string | null } = {}) {
  return buildToolExecutor(sdb, { conversationId, phoneE164, customerId: extra.customerId ?? null, lastInboundId: "in-1", now: NOW, ...(extra.dryRun ? { dryRun: true } : {}) });
}

async function wasend() {
  return db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, "wa.send"));
}

describe("entrar_no_provador", () => {
  it("sem sala registrada, sem cartela ou sem nome: recusa dizendo o que falta; nada é enviado", async () => {
    const conv = await conversation();
    const run = executor(conv);
    expect(await run("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: false, text: expect.stringContaining("ainda não tem uma sala") });
    await registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
    expect(await run("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: false, text: expect.stringContaining("Ainda não sei o tamanho dela") });
    await cartela(ANA);
    expect(await run("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: false, text: expect.stringContaining("não sei o nome dela") });
    expect(await wasend()).toHaveLength(0);
    expect(await db.select().from(schema.customers)).toHaveLength(0);
    // O modelo não pode pular o sim.
    expect(await run("entrar_no_provador", { cliente_autorizou: false })).toMatchObject({ ok: false, text: expect.stringContaining("Dados inválidos") });
  });

  it("com cartela e nome: nasce o cadastro com opt-in (auditado), o cartão + link saem pela fila UMA vez por dia, e o sync marca 'pela Lia' quando ela entra", async () => {
    await registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
    await cartela(ANA);
    const conv = await conversation();
    const run = executor(conv);
    const result = await run("entrar_no_provador", { cliente_autorizou: true, nome: "Ana Souza" });
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining("enviou à cliente o cartão de boas-vindas do Provador TRIVÉ") });
    expect(result.text).toContain('não diga que ela "já está"');

    const [customer] = await db.select().from(schema.customers);
    expect(customer).toMatchObject({ fullName: "Ana Souza", phoneE164: ANA, marketingOptIn: true });
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actorId, customer.id));
    expect(audits.map((a) => a.action).sort()).toEqual(["wa.opt_in", "wa.provador_invite"]);
    const sends = await wasend();
    expect(sends).toHaveLength(1);
    const payload = sends[0]!.payload as { body: string; phoneE164: string; customerId: string; dedupeKey: string };
    expect(payload.phoneE164).toBe(ANA);
    expect(payload.customerId).toBe(customer.id);
    expect(payload.body.startsWith("Bem-vinda ao Provador TRIVÉ, Ana. Aqui as peças passam antes de ir para a vitrine.")).toBe(true);
    expect(payload.body).toContain("Seu convite: https://chat.whatsapp.com/convite");
    expect(payload.body).toContain('"SAIR" desliga tudo');
    expect(payload.dedupeKey).toBe(`wa.provador_invite:${ANA}:2026-09-22`);

    // Chamou de novo no mesmo dia: o convite não sai duas vezes (dedupe), o opt-in continua.
    await run("entrar_no_provador", { cliente_autorizou: true });
    expect(await wasend()).toHaveLength(1);

    // Ela tocou no link e entrou: o sync a reconhece como "pela Lia".
    provider.setGroup(metadata([{ phoneE164: "+5591981037536", lid: null, isAdmin: true }, { phoneE164: ANA, lid: null, isAdmin: false }]));
    const [group] = await db.select().from(schema.waGroups);
    await syncGroupMembers(sdb, provider, { groupId: group.id, now: new Date(NOW.getTime() + 3_600_000) });
    const members = await listGroupMembers(sdb, { groupId: group.id });
    expect(members.find((m) => m.phoneE164 === ANA)).toMatchObject({ source: "lia", customerId: customer.id, marketingOptIn: true, hasProfile: true });

    // Já na sala: a ferramenta diz isso e não manda nada.
    const again = await run("entrar_no_provador", { cliente_autorizou: true });
    expect(again).toMatchObject({ ok: true, text: expect.stringContaining("já está no Provador TRIVÉ") });
    expect(await wasend()).toHaveLength(1);

    // Saiu e voltou por um convite novo da Lia: "pela Lia" de novo (não a origem velha).
    await db.update(schema.waGroupMembers).set({ leftAt: NOW, leftReason: "saiu", source: "sync" }).where(eq(schema.waGroupMembers.phoneE164, ANA));
    await syncGroupMembers(sdb, provider, { groupId: group.id, now: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect((await listGroupMembers(sdb, { groupId: group.id })).find((m) => m.phoneE164 === ANA)).toMatchObject({ source: "lia", leftAt: null });
  });

  it("cadastro existente sem opt-in ganha o opt-in; nome vem do perfil do WhatsApp quando não há cadastro; número oculto não entra; ensaio não faz nada", async () => {
    await registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
    await cartela(ANA);
    const [existing] = await db.insert(schema.customers).values({ fullName: "Ana Souza", phoneE164: ANA, marketingOptIn: false }).returning({ id: schema.customers.id });
    const conv = await conversation();
    expect(await executor(conv, ANA, { customerId: existing.id })("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: true });
    expect((await db.select().from(schema.customers))[0]?.marketingOptIn).toBe(true);
    const [optIn] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, "wa.opt_in"), eq(schema.auditLog.entityId, existing.id)));
    expect(optIn?.before).toEqual({ marketingOptIn: false });

    // Nome do WhatsApp (caderninho) basta quando não há cadastro.
    const BIA = "+5591999990002";
    await cartela(BIA);
    const convBia = await conversation(BIA, "Bia 🌸");
    expect(await executor(convBia, BIA)("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: true });
    expect((await db.select().from(schema.customers).where(eq(schema.customers.phoneE164, BIA)))[0]?.fullName).toBe("Bia 🌸");

    // Número oculto (LID): sem telefone para cadastrar.
    const LID = "220839349862480@lid";
    const convLid = await conversation(LID);
    expect(await executor(convLid, LID)("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: false, text: expect.stringContaining("esconde o número") });

    // Ensaio: nada é gravado nem enviado.
    const before = (await wasend()).length;
    expect(await executor(conv, ANA, { dryRun: true })("entrar_no_provador", { cliente_autorizou: true })).toMatchObject({ ok: true });
    expect(await wasend()).toHaveLength(before);
  });

  it("mimo de boas-vindas ligado: cupom pessoal de primeira compra (origem provador_welcome) vai no cartão, UM por cliente para sempre; desligado, nada", async () => {
    await registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
    await cartela(ANA);
    await db.insert(schema.settings).values([
      { key: "provador_welcome_gift_enabled", value: true },
      { key: "provador_welcome_gift_percent", value: 15 },
      { key: "provador_welcome_gift_days", value: 20 },
    ]);
    const conv = await conversation();
    const result = await executor(conv)("entrar_no_provador", { cliente_autorizou: true, nome: "Ana Souza" });
    expect(result.text).toContain("mimo de boas-vindas");
    const [coupon] = await db.select().from(schema.coupons);
    expect(coupon).toMatchObject({ origin: "provador_welcome", type: "percent", value: 15, firstPurchaseOnly: true, perCustomerLimit: 1, maxUses: 1 });
    expect(coupon.code.startsWith("ANA-")).toBe(true);
    expect(coupon.expiresAt?.getTime()).toBe(NOW.getTime() + 20 * 86_400_000);
    const [send] = await wasend();
    const body = (send!.payload as { body: string }).body;
    expect(body).toContain(`Seu mimo de boas-vindas: ${coupon.code} — 15% na primeira compra, até 12/10.`);
    expect(body.indexOf("Seu convite:")).toBeLessThan(body.indexOf("Seu mimo"));

    // Saiu, voltou, pediu de novo dias depois: o mesmo cupom, nenhum novo — e o cartão fala do cupom como ele É.
    await db.delete(schema.outboxEvents);
    await db.update(schema.waGroupMembers).set({ leftAt: NOW, leftReason: "saiu" });
    await db.update(schema.settings).set({ value: 40 }).where(eq(schema.settings.key, "provador_welcome_gift_percent"));
    const again = await buildToolExecutor(sdb, { conversationId: conv, phoneE164: ANA, customerId: null, lastInboundId: "in-2", now: new Date(NOW.getTime() + 2 * 86_400_000) })("entrar_no_provador", { cliente_autorizou: true });
    expect(again).toMatchObject({ ok: true });
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
    const bodyAgain = ((await wasend())[0]!.payload as { body: string }).body;
    expect(bodyAgain).toContain(`${coupon.code} — 15% na primeira compra, até 12/10.`);

    // Cupom morto (a dona desativou): o cartão não fala dele, e nenhum novo nasce.
    await db.delete(schema.outboxEvents);
    await db.update(schema.coupons).set({ isActive: false });
    await db.update(schema.waGroupMembers).set({ leftAt: NOW, leftReason: "saiu" });
    await buildToolExecutor(sdb, { conversationId: conv, phoneE164: ANA, customerId: null, lastInboundId: "in-3", now: new Date(NOW.getTime() + 3 * 86_400_000) })("entrar_no_provador", { cliente_autorizou: true });
    expect(((await wasend())[0]!.payload as { body: string }).body).not.toContain("mimo");
    expect(await db.select().from(schema.coupons)).toHaveLength(1);
    await db.update(schema.coupons).set({ isActive: true });

    // Cliente da casa (já comprou): o mimo vale na PRÓXIMA compra, não na "primeira".
    const BIA = "+5591999990002";
    await cartela(BIA);
    const [bia] = await db.insert(schema.customers).values({ fullName: "Bia Lima", phoneE164: BIA, marketingOptIn: true }).returning({ id: schema.customers.id });
    await db.insert(schema.orders).values({ orderNumber: 1001, customerId: bia.id, status: "paid", channel: "whatsapp", subtotalCents: 10000, discountCents: 0, shippingCents: 0, totalCents: 10000, paidAt: NOW });
    await db.delete(schema.outboxEvents);
    const convBia = await conversation(BIA, "Bia");
    await executor(convBia, BIA, { customerId: bia.id })("entrar_no_provador", { cliente_autorizou: true });
    const biaCoupon = (await db.select().from(schema.coupons).where(eq(schema.coupons.customerId, bia.id)))[0]!;
    expect(biaCoupon.firstPurchaseOnly).toBe(false);
    expect(((await wasend())[0]!.payload as { body: string }).body).toContain(`${biaCoupon.code} — 40% na próxima compra`);

    // Desligado: cartão sem mimo.
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "provador_welcome_gift_enabled"));
    const CRIS = "+5591999990003";
    await cartela(CRIS);
    await db.delete(schema.outboxEvents);
    const convCris = await conversation(CRIS, "Cris");
    await executor(convCris, CRIS)("entrar_no_provador", { cliente_autorizou: true });
    expect(((await wasend())[0]!.payload as { body: string }).body).not.toContain("mimo");
    expect(await db.select().from(schema.coupons)).toHaveLength(2);
  });

  it("Provador desligado: recusa sem tocar em nada", async () => {
    await registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
    await cartela(ANA);
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "groups_enabled"));
    const conv = await conversation();
    expect(await executor(conv)("entrar_no_provador", { cliente_autorizou: true, nome: "Ana" })).toMatchObject({ ok: false, text: expect.stringContaining("desligado") });
    expect(await db.select().from(schema.customers)).toHaveLength(0);
  });
});

describe("porta de entrada (/provador)", () => {
  it("leva ao wa.me da loja com a frase pronta; sem número, null", async () => {
    expect(provadorEntryMessage("Lia")).toBe("Oi Lia, quero entrar no Provador");
    expect(provadorEntryMessage("  ")).toBe("Oi Lia, quero entrar no Provador");
    expect(await provadorEntryUrl(sdb)).toBe("https://wa.me/5591981037536?text=Oi%20Lia%2C%20quero%20entrar%20no%20Provador");
    await db.update(schema.settings).set({ value: "" }).where(eq(schema.settings.key, "store_whatsapp"));
    expect(await provadorEntryUrl(sdb)).toBeNull();
  });
});
