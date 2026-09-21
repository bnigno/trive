// Provador ponta a ponta (PGlite + fake da Z-API): registrar a sala pelo
// metadata, sincronizar membras (e o kill switch), compor e agendar os
// rituais respeitando a cadência, enviar pela fila (texto, enquete, fora da
// janela), apurar a enquete com os votos que o webhook gravou, e os sinais
// (voto que muda, reação, menção, mensagem) sem duplicar no replay.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupMetadata } from "@/adapters/zapi";
import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  closeGroupPoll,
  composeGroupPost,
  getGroupPostStats,
  HOUSE_RULES,
  listGroupMembers,
  listGroupPosts,
  POLL_CLOSE_AFTER_HOURS,
  processGroupInbound,
  provadorSlug,
  registerGroup,
  scheduleGroupPost,
  sendGroupPost,
  syncGroupMembers,
  applyHouseRules,
  cancelGroupPost,
} from "@/services/wa-groups";
import { processZapiInbound } from "@/services/wa-inbound";
import { createTestCustomer, createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

const kicks: unknown[] = [];
vi.mock("@/inngest/client", () => ({ inngest: { send: async (event: unknown) => { kicks.push(event); return { ids: [] }; } } }));

const GROUP = "120363019502650977-group";
const ANA = "+5591999990001";
const BIA = "+5591999990002";
const LID = "220839349862480@lid";
// Segunda 2026-09-21 10:00 SP.
const NOW = new Date("2026-09-21T13:00:00Z");
const sp = (day: string, hour: number) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00-03:00`);

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;

const metadata = (participants: GroupMetadata["participants"]): GroupMetadata => ({
  groupId: GROUP,
  name: "Provador TRIVÉ",
  description: null,
  ownerE164: "+5591981037536",
  invitationLink: "https://chat.whatsapp.com/fake",
  adminOnlyMessage: false,
  adminOnlySettings: false,
  requireAdminApproval: false,
  participants,
});

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  kicks.length = 0;
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "groups_enabled", value: true },
    { key: "bot_seller_name", value: "Lia" },
    { key: "store_whatsapp", value: "(91) 98103-7536" },
  ]);
  provider.setGroup(
    metadata([
      { phoneE164: "+5591981037536", lid: null, isAdmin: true },
      { phoneE164: ANA, lid: null, isAdmin: false },
      { phoneE164: null, lid: LID, isAdmin: false },
    ]),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function registered() {
  return registerGroup(sdb, provider, { providerGroupId: GROUP, userId: FIXED_USER_ID });
}

async function pricedProduct(name: string, sizes: { size: string; onHand: number }[], priceCents = 28900): Promise<string> {
  let productId = "";
  for (const [index, entry] of sizes.entries()) {
    const sku = `${name.toUpperCase().replace(/\s+/g, "-")}-${entry.size}`;
    if (index === 0) {
      const created = await createTestVariant(db, { sku, onHand: entry.onHand, name });
      productId = created.productId;
      await db.update(schema.productVariants).set({ attributes: { tamanho: entry.size } }).where(eq(schema.productVariants.id, created.variantId));
      await price(created.variantId, priceCents);
    } else {
      const [variant] = await db
        .insert(schema.productVariants)
        .values({ productId, sku, costCents: 1000, attributes: { tamanho: entry.size } })
        .returning({ id: schema.productVariants.id });
      await db.insert(schema.stockLevels).values({ productVariantId: variant.id, onHand: entry.onHand, reserved: 0 });
      await price(variant.id, priceCents);
    }
  }
  return productId;
}

async function price(variantId: string, priceCents: number) {
  await db.insert(schema.priceVersions).values({
    productVariantId: variantId,
    versionNumber: 1,
    status: "active",
    priceCents,
    origin: "initial",
    breakdown: {},
    costSnapshotCents: 1000,
    computedMarginRate: "0.3000",
    activatedAt: new Date(),
  });
}

async function outbox(eventType: string) {
  return db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, eventType));
}

describe("registrar e sincronizar a sala", () => {
  it("registra pelo metadata (nome, link, membras por telefone ou LID, cliente ligada pelo telefone); registrar de novo devolve a mesma", async () => {
    const anaId = await createTestCustomer(db, "Ana Souza");
    await db.update(schema.customers).set({ phoneE164: ANA }).where(eq(schema.customers.id, anaId));

    const group = await registered();
    expect(group).toMatchObject({ providerGroupId: GROUP, name: "Provador TRIVÉ", kind: "provador", invitationLink: "https://chat.whatsapp.com/fake", memberCount: 3, isActive: true });
    const members = await listGroupMembers(sdb, { groupId: group.id });
    expect(members.map((m) => [m.phoneE164, m.customerId, m.isAdmin, m.source]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["+5591981037536", null, true, "sync"],
      [ANA, anaId, false, "sync"],
      [LID, null, false, "sync"],
    ]);
    const again = await registered();
    expect(again.id).toBe(group.id);
    expect(await db.select().from(schema.waGroups)).toHaveLength(1);

    await expect(registerGroup(sdb, provider, { providerGroupId: "+5591999990001", userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "grupo_invalido" });
  });

  it("regras da casa: grupo aberto, só admins mudam e adicionam", async () => {
    const group = await registered();
    await applyHouseRules(sdb, provider, { groupId: group.id, userId: FIXED_USER_ID });
    expect(provider.groupSettingsUpdates).toEqual([{ groupId: GROUP, settings: HOUSE_RULES }]);
    expect(HOUSE_RULES).toEqual({ adminOnlyMessage: false, adminOnlySettings: true, requireAdminApproval: false, adminOnlyAddMember: true });
  });

  it("sync: quem saiu ganha left_at/saiu, quem entrou nasce, quem voltou limpa a saída; nome novo do grupo entra", async () => {
    const group = await registered();
    provider.setGroup({
      ...metadata([
        { phoneE164: "+5591981037536", lid: null, isAdmin: true },
        { phoneE164: BIA, lid: null, isAdmin: false },
      ]),
      name: "Provador Belém",
    });
    const first = await syncGroupMembers(sdb, provider, { groupId: group.id, now: NOW });
    expect(first).toEqual({ joined: 1, left: 2, total: 2, paused: false });
    const all = await listGroupMembers(sdb, { groupId: group.id, includeLeft: true });
    expect(all.find((m) => m.phoneE164 === ANA)).toMatchObject({ leftAt: NOW, leftReason: "saiu" });
    expect(all.find((m) => m.phoneE164 === BIA)).toMatchObject({ leftAt: null, source: "sync" });
    expect((await db.select().from(schema.waGroups))[0]).toMatchObject({ name: "Provador Belém", memberCount: 2, lastSyncedAt: NOW });

    provider.setGroup(metadata([{ phoneE164: "+5591981037536", lid: null, isAdmin: true }, { phoneE164: BIA, lid: null, isAdmin: false }, { phoneE164: ANA, lid: null, isAdmin: false }]));
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await syncGroupMembers(sdb, provider, { groupId: group.id, now: later })).toMatchObject({ joined: 1, left: 0, total: 3 });
    expect((await listGroupMembers(sdb, { groupId: group.id })).find((m) => m.phoneE164 === ANA)).toMatchObject({ leftAt: null, leftReason: null, joinedAt: later });
    expect(await db.select().from(schema.waGroupMembers)).toHaveLength(4);
  });

  it("a mesma pessoa vindo hoje pelo telefone e amanhã pelo LID (ou o contrário) não vira saída nem entrada", async () => {
    const group = await registered();
    // Ana passa a vir só pelo LID; a do LID passa a vir com telefone + LID.
    provider.setGroup(
      metadata([
        { phoneE164: "+5591981037536", lid: null, isAdmin: true },
        { phoneE164: null, lid: "77777777777777@lid", isAdmin: false },
        { phoneE164: BIA, lid: LID, isAdmin: false },
      ]),
    );
    // Ana antes tinha o LID guardado à parte.
    await db.update(schema.waGroupMembers).set({ lid: "77777777777777@lid" }).where(eq(schema.waGroupMembers.phoneE164, ANA));
    const result = await syncGroupMembers(sdb, provider, { groupId: group.id, now: NOW });
    expect(result).toMatchObject({ joined: 0, left: 0, total: 3 });
    const rows = await listGroupMembers(sdb, { groupId: group.id, includeLeft: true });
    expect(rows.map((m) => [m.phoneE164, m.leftAt]).sort()).toEqual([
      ["+5591981037536", null],
      [ANA, null],
      // A linha que nasceu pelo LID subiu para o telefone.
      [BIA, null],
    ]);
    expect(await db.select().from(schema.waGroupMembers)).toHaveLength(3);
  });

  it("kill switch: saídas acima do % nas 24 h após um post pausam a sala e avisam a dona UMA vez", async () => {
    await db.insert(schema.settings).values({ key: "group_kill_switch_pct", value: 2 });
    const group = await registered();
    // Sala de 100: 97 membras extras.
    const extras = Array.from({ length: 97 }, (_, i) => ({ phoneE164: `+55919990${String(i).padStart(4, "0")}`, lid: null, isAdmin: false }));
    provider.setGroup(metadata([{ phoneE164: "+5591981037536", lid: null, isAdmin: true }, { phoneE164: ANA, lid: null, isAdmin: false }, { phoneE164: null, lid: LID, isAdmin: false }, ...extras]));
    await syncGroupMembers(sdb, provider, { groupId: group.id, now: NOW });
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: null, userId: FIXED_USER_ID, post: { kind: "livre", body: "Oi" } }, { now: sp("2026-09-22", 10) });
    expect(await sendGroupPost(sdb, provider, { postId: post.id, now: sp("2026-09-22", 10) })).toMatchObject({ sent: true });

    // 3 saem em 2 h (Ana, a do LID e uma extra): 3 % > 2 %.
    provider.setGroup(metadata([{ phoneE164: "+5591981037536", lid: null, isAdmin: true }, ...extras.slice(1)]));
    const result = await syncGroupMembers(sdb, provider, { groupId: group.id, now: sp("2026-09-22", 12) });
    expect(result).toMatchObject({ left: 3, paused: true });
    const [row] = await db.select().from(schema.waGroups);
    expect(row.pausedUntil?.getTime()).toBe(sp("2026-09-22", 12).getTime() + 7 * 86_400_000);
    expect(row.pausedReason).toBe("3 de 100 saíram nas 24 h depois do post de livre");
    const alerts = await outbox("wa.owner_forward");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ raw: true, dedupeKey: `wa.group_kill_switch:${post.id}` });
    // Sync seguinte: já pausada, não avisa de novo.
    expect(await syncGroupMembers(sdb, provider, { groupId: group.id, now: sp("2026-09-22", 13) })).toMatchObject({ paused: true });
    expect(await outbox("wa.owner_forward")).toHaveLength(1);
    // Uma saída só nunca pausa (mesmo em sala pequena).
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "wa_group.pause"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorType).toBe("system");
  });
});

describe("compor e agendar rituais", () => {
  it("Passou pelo Provador: preço e estoque de verdade por tamanho, link prov-… do dia; peça sem estoque é recusada", async () => {
    const terracota = await pricedProduct("Vestido Terracota", [{ size: "P", onHand: 2 }, { size: "M", onHand: 3 }, { size: "G", onHand: 1 }]);
    const areia = await pricedProduct("Calça Areia", [{ size: "M", onHand: 2 }], 24900);
    const composed = await composeGroupPost(sdb, { kind: "chegadas", productIds: [terracota, areia], vitrineWhen: "amanhã às 9h" }, { day: "2026-09-22" });
    expect(composed.slug).toBe("prov-20260922-chegadas");
    expect(composed.link).toMatch(/\/ig\/prov-20260922-chegadas$/);
    expect(composed.linkLabel).toBe("Provador · chegadas 22/09");
    expect(composed.body).toContain("1. Vestido Terracota — R$ 289 · tem 2 P, 3 M, 1 G");
    expect(composed.body).toContain("2. Calça Areia — R$ 249 · só 2 M");
    expect(composed.body).toContain(`Vão para a vitrine amanhã às 9h. Quem quiser antes: ${composed.link}`);
    expect(composed.body).not.toContain("Preço protegido");

    const esgotada = await pricedProduct("Blusa Esgotada", [{ size: "M", onHand: 0 }]);
    await expect(composeGroupPost(sdb, { kind: "chegadas", productIds: [esgotada] }, { day: "2026-09-22" })).rejects.toMatchObject({ code: "peca_sem_estoque" });
    await expect(composeGroupPost(sdb, { kind: "chegadas", productIds: ["00000000-0000-4000-8000-000000000009"] }, { day: "2026-09-22" })).rejects.toMatchObject({ code: "peca_inexistente" });
  });

  it("Quem vestiu só com look consentido e aprovado; enquete inválida diz o problema", async () => {
    const productId = await pricedProduct("Vestido Terracota", [{ size: "M", onHand: 3 }]);
    const [variant] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(eq(schema.productVariants.productId, productId));
    const [look] = await db
      .insert(schema.customerLooks)
      .values({ phoneE164: ANA, productId, productVariantId: variant.id, displayName: "Ana", consentAnswer: "sim", approvedAt: NOW })
      .returning({ id: schema.customerLooks.id });
    const composed = await composeGroupPost(sdb, { kind: "quem_vestiu", lookIds: [look.id], photoCoupon: false }, { day: "2026-09-26" });
    expect(composed.body).toContain("Ana, com Vestido Terracota em M. Ela mandou a foto e deixou a gente mostrar.");
    expect(composed.body).toContain("até as 21h");
    expect(composed.lookIds).toEqual([look.id]);

    const [pending] = await db.insert(schema.customerLooks).values({ phoneE164: BIA, productId, displayName: "Bia" }).returning({ id: schema.customerLooks.id });
    await expect(composeGroupPost(sdb, { kind: "quem_vestiu", lookIds: [pending.id] }, { day: "2026-09-26" })).rejects.toMatchObject({ code: "look_sem_consentimento" });
    await expect(composeGroupPost(sdb, { kind: "enquete", question: "Qual?", options: ["A"] }, { day: "2026-09-24" })).rejects.toMatchObject({ code: "enquete_poucas_opcoes" });
    const poll = await composeGroupPost(sdb, { kind: "enquete", question: "Qual cor?", options: ["Vinho", "Verde"], outcome: "chega em 15 dias", voterHoldHours: 24 }, { day: "2026-09-24" });
    expect(poll).toMatchObject({ body: "Vocês decidem. Qual cor?\nA que ganhar chega em 15 dias. Quem votou nela tem 24 h de reserva antes de todo mundo.", pollOptions: ["Vinho", "Verde"], pollMaxOptions: 1 });
  });

  it("agendar respeita a cadência (3/semana, 1/dia, domingo, janela), cria o link rastreável uma vez e enfileira wa.group_post na hora marcada", async () => {
    const group = await registered();
    const tue = sp("2026-09-22", 10);
    const p1 = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: tue, userId: FIXED_USER_ID, post: { kind: "livre", body: "Terça" } }, { now: NOW });
    expect(p1).toMatchObject({ kind: "livre", status: "scheduled", scheduledAt: tue, campaignSlug: "prov-20260922-post" });
    const [link] = await db.select().from(schema.campaignLinks);
    expect(link).toMatchObject({ slug: "prov-20260922-post", label: "Provador · post 22/09", productId: null });
    const [event] = await outbox("wa.group_post");
    expect(event).toMatchObject({ dedupeKey: `wa.group_post:${p1.id}`, nextAttemptAt: tue, payload: { postId: p1.id } });
    // Hora marcada no futuro: sem kick (o sweep entrega na hora).
    expect(kicks).toHaveLength(0);

    await expect(
      scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 18), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "cadencia_mesmo_dia" });
    await expect(
      scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-27", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "cadencia_dia_de_silencio" });
    await expect(
      scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-23", 22), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "cadencia_fora_da_janela" });
    await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-24", 19), userId: FIXED_USER_ID, post: { kind: "livre", body: "Quinta" } }, { now: NOW });
    await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-26", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "Sábado" } }, { now: NOW });
    await expect(
      scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-25", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW }),
    ).rejects.toMatchObject({ code: "cadencia_teto_semanal" });

    // Cancelar libera o dia; o mesmo ritual no mesmo dia reaproveita o link (um link por ritual e dia: 3 posts em 3 dias = 3 links).
    await cancelGroupPost(sdb, { postId: p1.id, userId: FIXED_USER_ID });
    const p1b = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 11), userId: FIXED_USER_ID, post: { kind: "livre", body: "Terça de novo" } }, { now: NOW });
    expect(p1b.campaignLinkId).toBe(link.id);
    expect(await db.select().from(schema.campaignLinks)).toHaveLength(3);
    await expect(cancelGroupPost(sdb, { postId: p1.id, userId: FIXED_USER_ID })).rejects.toMatchObject({ code: "post_nao_cancelavel" });

    const listed = await listGroupPosts(sdb, { groupId: group.id });
    expect(listed.map((p) => [p.body, p.status])).toEqual([
      ["Sábado", "scheduled"],
      ["Quinta", "scheduled"],
      ["Terça de novo", "scheduled"],
      ["Terça", "canceled"],
    ]);
  });

  it("'agora' (scheduledAt null) agenda para já e dá o kick; sala desligada recusa", async () => {
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: null, userId: FIXED_USER_ID, post: { kind: "livre", body: "Já" } }, { now: NOW });
    expect(post.scheduledAt).toEqual(NOW);
    expect(kicks).toHaveLength(1);
    await db.update(schema.waGroups).set({ isActive: false });
    await expect(
      scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: null, userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: sp("2026-09-22", 10) }),
    ).rejects.toMatchObject({ code: "sala_inativa" });
  });
});

describe("enviar pela fila", () => {
  it("texto vai para o id do grupo; enquete vai por sendPoll e agenda a apuração em 40 h; segundo envio pula (ja_enviado)", async () => {
    const group = await registered();
    const text = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "Passou pelo Provador hoje" } }, { now: NOW });
    const poll = await scheduleGroupPost(
      sdb,
      { groupId: group.id, scheduledAt: sp("2026-09-24", 19), userId: FIXED_USER_ID, post: { kind: "enquete", question: "Qual cor?", options: ["Vinho", "Verde"] } },
      { now: NOW },
    );
    const sentText = await sendGroupPost(sdb, provider, { postId: text.id, now: sp("2026-09-22", 10) });
    expect(sentText).toMatchObject({ sent: true });
    expect(provider.sentMessages).toEqual([{ providerMessageId: expect.any(String), toE164: GROUP, body: "Passou pelo Provador hoje" }]);
    expect(await sendGroupPost(sdb, provider, { postId: text.id, now: sp("2026-09-22", 10) })).toEqual({ skipped: "ja_enviado" });

    const sentPoll = await sendGroupPost(sdb, provider, { postId: poll.id, now: sp("2026-09-24", 19) });
    expect(sentPoll).toMatchObject({ sent: true });
    expect(provider.sentPolls).toEqual([{ toGroupId: GROUP, question: "Vocês decidem. Qual cor?", options: ["Vinho", "Verde"], maxOptions: 1, providerMessageId: expect.any(String) }]);
    const [closeEvent] = await outbox("wa.group_poll_close");
    expect(closeEvent).toMatchObject({ dedupeKey: `wa.group_poll_close:${poll.id}`, nextAttemptAt: new Date(sp("2026-09-24", 19).getTime() + POLL_CLOSE_AFTER_HOURS * 3_600_000) });
    const rows = await db.select().from(schema.waGroupPosts).where(eq(schema.waGroupPosts.id, poll.id));
    expect(rows[0]).toMatchObject({ status: "sent", providerMessageId: provider.sentPolls[0]?.providerMessageId });
  });

  it("a fila chegou tarde: até 30 min depois da janela ainda sai; horas depois, ou depois da folga, não sai NUNCA em outro dia — fica 'não saiu' e a dona é avisada", async () => {
    const group = await registered();
    const evening = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 20), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW });
    // 21:20 SP: folga da fila.
    expect(await sendGroupPost(sdb, provider, { postId: evening.id, now: new Date("2026-09-23T00:20:00Z") })).toMatchObject({ sent: true });

    const morning = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-24", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "y" } }, { now: NOW });
    expect(await sendGroupPost(sdb, provider, { postId: morning.id, now: sp("2026-09-24", 17) })).toEqual({ skipped: "atrasado" });
    expect((await db.select().from(schema.waGroupPosts).where(eq(schema.waGroupPosts.id, morning.id)))[0]).toMatchObject({ status: "skipped", skippedReason: "atrasado" });
    // Nada foi adiado para o dia seguinte.
    expect((await outbox("wa.group_post")).map((e) => e.dedupeKey).sort()).toEqual([`wa.group_post:${evening.id}`, `wa.group_post:${morning.id}`].sort());
    const alerts = await outbox("wa.owner_forward");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ raw: true, dedupeKey: `wa.group_post_skipped:${morning.id}` });
    expect(String((alerts[0]?.payload as { body: string }).body)).toContain("não saiu: a fila só chegou horas depois da hora marcada");

    const lateEvening = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-25", 20), userId: FIXED_USER_ID, post: { kind: "livre", body: "z" } }, { now: NOW });
    // 21:45 SP: passou da folga.
    expect(await sendGroupPost(sdb, provider, { postId: lateEvening.id, now: new Date("2026-09-26T00:45:00Z") })).toEqual({ skipped: "fora_da_janela" });
    expect(await outbox("wa.owner_forward")).toHaveLength(2);
    expect(provider.sentMessages).toHaveLength(1);
  });

  it("post agendado que a fila nunca alcançou não segura a cadência (a dona reagenda no mesmo dia)", async () => {
    const group = await registered();
    const stuck = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW });
    // 7 h depois, ainda 'scheduled' (provedor fora do ar): o mesmo dia aceita outro post.
    const later = sp("2026-09-22", 17);
    const again = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 18), userId: FIXED_USER_ID, post: { kind: "livre", body: "de novo" } }, { now: later });
    expect(again.status).toBe("scheduled");
    expect((await db.select().from(schema.waGroupPosts).where(eq(schema.waGroupPosts.id, stuck.id)))[0]?.status).toBe("scheduled");
    // Um post recém-agendado continua segurando o dia.
    await expect(
      scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 19), userId: FIXED_USER_ID, post: { kind: "livre", body: "terceiro" } }, { now: later }),
    ).rejects.toMatchObject({ code: "cadencia_mesmo_dia" });
  });

  it("Provador desligado, sala pausada ou post cancelado viram skipped com motivo (sem aviso à dona quando foi ela que pausou)", async () => {
    const group = await registered();
    const post = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-22", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "x" } }, { now: NOW });
    await db.update(schema.waGroups).set({ pausedUntil: sp("2026-09-30", 0), pausedReason: "teste" });
    expect(await sendGroupPost(sdb, provider, { postId: post.id, now: sp("2026-09-22", 10) })).toEqual({ skipped: "sala_pausada" });
    expect((await db.select().from(schema.waGroupPosts))[0]).toMatchObject({ status: "skipped", skippedReason: "sala_pausada" });
    expect(await outbox("wa.owner_forward")).toHaveLength(0);

    await db.update(schema.waGroups).set({ pausedUntil: null });
    const other = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-24", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "y" } }, { now: NOW });
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "groups_enabled"));
    expect(await sendGroupPost(sdb, provider, { postId: other.id, now: sp("2026-09-24", 10) })).toEqual({ skipped: "provador_desligado" });
    await db.update(schema.settings).set({ value: true }).where(eq(schema.settings.key, "groups_enabled"));

    const canceled = await scheduleGroupPost(sdb, { groupId: group.id, scheduledAt: sp("2026-09-25", 10), userId: FIXED_USER_ID, post: { kind: "livre", body: "z" } }, { now: NOW });
    await cancelGroupPost(sdb, { postId: canceled.id, userId: FIXED_USER_ID });
    expect(await sendGroupPost(sdb, provider, { postId: canceled.id, now: sp("2026-09-25", 10) })).toEqual({ skipped: "cancelado" });
    expect(await sendGroupPost(sdb, provider, { postId: "00000000-0000-4000-8000-000000000000", now: NOW })).toEqual({ skipped: "inexistente" });
  });
});

describe("sinais do grupo e apuração da enquete", () => {
  async function sentPoll() {
    const group = await registered();
    const poll = await scheduleGroupPost(
      sdb,
      { groupId: group.id, scheduledAt: sp("2026-09-24", 19), userId: FIXED_USER_ID, post: { kind: "enquete", question: "Qual cor?", options: ["Vinho", "Verde", "Azul"] } },
      { now: NOW },
    );
    await sendGroupPost(sdb, provider, { postId: poll.id, now: sp("2026-09-24", 19) });
    const pollMessageId = provider.sentPolls[0]!.providerMessageId;
    return { group, poll, pollMessageId };
  }

  it("voto: o último de cada pessoa vale (upsert), sinal ligado ao post e à cliente; reação e menção também; mensagem comum só o fato; replay não duplica", async () => {
    const anaId = await createTestCustomer(db, "Ana");
    await db.update(schema.customers).set({ phoneE164: ANA }).where(eq(schema.customers.id, anaId));
    const { poll, pollMessageId } = await sentPoll();
    const vote = (messageId: string, phone: string, options: string[]) =>
      processGroupInbound(sdb, { messageId, phone: GROUP, participantPhone: phone.replace("+", ""), pollVote: { pollMessageId, options: options.map((name) => ({ name })) } }, { now: NOW });

    expect(await vote("V-1", ANA, ["Vinho"])).toMatchObject({ recorded: true, kind: "poll_vote", postId: poll.id });
    expect(await vote("V-2", ANA, ["Verde"])).toMatchObject({ recorded: true });
    expect(await vote("V-3", BIA, ["Verde"])).toMatchObject({ recorded: true });
    // Replay do mesmo evento: nada muda.
    expect(await vote("V-3", BIA, ["Verde"])).toMatchObject({ recorded: true });
    const votes = await db.select().from(schema.waGroupSignals).where(eq(schema.waGroupSignals.kind, "poll_vote"));
    expect(votes.map((v) => [v.participantPhone, v.value, v.customerId, v.postId]).sort()).toEqual([
      [ANA, '["Verde"]', anaId, poll.id],
      [BIA, '["Verde"]', null, poll.id],
    ]);

    expect(
      await processGroupInbound(sdb, { messageId: "R-1", phone: GROUP, participantPhone: "5591999990001", reaction: { value: "❤️", reactionBy: "5591999990001", referencedMessage: { messageId: pollMessageId } } }),
    ).toMatchObject({ recorded: true, kind: "reaction", postId: poll.id });
    expect(await processGroupInbound(sdb, { messageId: "M-1", phone: GROUP, participantLid: LID, text: "@Lia tem em M?" })).toMatchObject({ recorded: true, kind: "mention" });
    expect(await processGroupInbound(sdb, { messageId: "M-2", phone: GROUP, participantPhone: "5591999990002", text: "meninas, amei" })).toMatchObject({ recorded: true, kind: "message" });
    expect(await processGroupInbound(sdb, { messageId: "M-2", phone: GROUP, participantPhone: "5591999990002", text: "meninas, amei" })).toMatchObject({ recorded: true, kind: "message" });
    const all = await db.select().from(schema.waGroupSignals);
    expect(all).toHaveLength(5);
    expect(all.find((s) => s.kind === "mention")).toMatchObject({ participantPhone: LID, value: "@Lia tem em M?" });
    expect(all.find((s) => s.kind === "message")).toMatchObject({ value: "" });

    expect(await getGroupPostStats(sdb, poll.id)).toEqual({ reactions: 1, votes: 2, mentions: 0, taps: 0, conversations: 0, orders: 0 });
  });

  it("ignora: Provador desligado (nem conta), sala desconhecida, sala inativa, eco nosso", async () => {
    const { pollMessageId } = await sentPoll();
    expect(await processGroupInbound(sdb, { messageId: "X-1", phone: "999999999999999-group", participantPhone: "5591999990001", text: "oi" })).toEqual({ ignored: "sala_desconhecida" });
    expect(await processGroupInbound(sdb, { messageId: "X-2", phone: GROUP, participantPhone: "5591999990001", fromMe: true, text: "oi" })).toEqual({ ignored: "nao_e_sinal" });
    await db.update(schema.waGroups).set({ isActive: false });
    expect(await processGroupInbound(sdb, { messageId: "X-3", phone: GROUP, participantPhone: "5591999990001", text: "oi" })).toEqual({ ignored: "sala_inativa" });
    await db.update(schema.waGroups).set({ isActive: true });
    await db.update(schema.settings).set({ value: false }).where(eq(schema.settings.key, "groups_enabled"));
    expect(await processGroupInbound(sdb, { messageId: "X-4", phone: GROUP, participantPhone: "5591999990001", pollVote: { pollMessageId, options: [{ name: "Vinho" }] } })).toEqual({ ignored: "provador_desligado" });
    expect(await db.select().from(schema.waGroupSignals)).toHaveLength(0);
  });

  it("o webhook da Z-API desvia grupo para o sinal (voto, reação, texto) e nunca abre conversa", async () => {
    process.env.ZAPI_WEBHOOK_SECRET = "segredo";
    const { poll, pollMessageId } = await sentPoll();
    const base = { instanceId: "i", isGroup: true, phone: GROUP, chatName: "Provador TRIVÉ", senderName: "Ana", fromMe: false, momment: 1, status: "RECEIVED", type: "ReceivedCallback" };
    const vote = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-1", participantPhone: "5591999990001", pollVote: { pollMessageId, options: [{ name: "Azul" }] } } });
    expect(vote).toMatchObject({ action: "group", group: { recorded: true, kind: "poll_vote", postId: poll.id } });
    const reaction = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-2", participantPhone: "5591999990001", reaction: { value: "❤️", time: 1, reactionBy: "5591999990001", referencedMessage: { messageId: pollMessageId, fromMe: true, phone: GROUP, participant: null } } } });
    expect(reaction).toMatchObject({ action: "group", group: { recorded: true, kind: "reaction" } });
    const text = await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-3", participantPhone: "5591999990002", participantLid: LID, text: { message: "alguém tem em M?" } } });
    expect(text).toMatchObject({ action: "group", group: { recorded: true, kind: "message" } });
    // Eco nosso no grupo: ignorado como sempre.
    expect(await processZapiInbound(sdb, { providedSecret: "segredo", body: { ...base, messageId: "W-4", fromMe: true, text: { message: "Passou pelo Provador" } } })).toMatchObject({ action: "ignored" });
    expect(await db.select().from(schema.waConversations)).toHaveLength(0);
    expect(await db.select().from(schema.inboundEvents)).toHaveLength(0);
    delete process.env.ZAPI_WEBHOOK_SECRET;
  });

  it("apura: última escolha de cada uma, anuncia citando a enquete, guarda o resultado; segunda apuração pula; sem votos apura em silêncio", async () => {
    const { poll, pollMessageId } = await sentPoll();
    for (const [id, phone, options] of [["V-1", "5591999990001", ["Vinho"]], ["V-2", "5591999990001", ["Verde"]], ["V-3", "5591999990002", ["Verde"]], ["V-4", "5591999990003", ["Azul"]]] as const) {
      await processGroupInbound(sdb, { messageId: id, phone: GROUP, participantPhone: phone, pollVote: { pollMessageId, options: options.map((name) => ({ name })) } });
    }
    const closed = await closeGroupPoll(sdb, provider, { postId: poll.id, now: sp("2026-09-26", 11) });
    expect(closed).toEqual({ closed: true, winner: "Verde", voters: 3, announced: true });
    const announced = provider.sentMessages.at(-1);
    expect(announced).toMatchObject({ toE164: GROUP, body: "Deu Verde: 2 de 3 votos.", quotedProviderMessageId: pollMessageId });
    const [row] = await db.select().from(schema.waGroupPosts).where(eq(schema.waGroupPosts.id, poll.id));
    expect(row.pollClosedAt).toEqual(sp("2026-09-26", 11));
    expect(row.pollResult).toEqual({
      tally: [{ option: "Vinho", votes: 0 }, { option: "Verde", votes: 2 }, { option: "Azul", votes: 1 }],
      winner: "Verde",
      voters: 3,
      resultMessageId: announced?.providerMessageId,
    });
    expect(await closeGroupPoll(sdb, provider, { postId: poll.id, now: sp("2026-09-26", 12) })).toEqual({ skipped: "ja_apurada" });

    // Enquete nova sem votos: apura em silêncio (nada no grupo).
    const empty = await scheduleGroupPost(sdb, { groupId: (await db.select().from(schema.waGroups))[0]!.id, scheduledAt: sp("2026-09-29", 19), userId: FIXED_USER_ID, post: { kind: "enquete", question: "?", options: ["A", "B"] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: empty.id, now: sp("2026-09-29", 19) });
    const before = provider.sentMessages.length;
    expect(await closeGroupPoll(sdb, provider, { postId: empty.id, now: sp("2026-10-01", 11) })).toEqual({ closed: true, winner: null, voters: 0, announced: false });
    expect(provider.sentMessages).toHaveLength(before);
    // Fora da janela: adia com dedupe datado para o próximo instante publicável — sábado 7h vira sábado 9h; domingo vira segunda 9h.
    const late = await scheduleGroupPost(sdb, { groupId: (await db.select().from(schema.waGroups))[0]!.id, scheduledAt: sp("2026-10-01", 19), userId: FIXED_USER_ID, post: { kind: "enquete", question: "?", options: ["A", "B"] } }, { now: NOW });
    await sendGroupPost(sdb, provider, { postId: late.id, now: sp("2026-10-01", 19) });
    expect(await closeGroupPoll(sdb, provider, { postId: late.id, now: sp("2026-10-03", 7) })).toEqual({ skipped: "fora_da_janela" });
    const deferred = await db.select().from(schema.outboxEvents).where(and(eq(schema.outboxEvents.eventType, "wa.group_poll_close"), eq(schema.outboxEvents.dedupeKey, `wa.group_poll_close:${late.id}:2026-10-03`)));
    expect(deferred[0]?.nextAttemptAt).toEqual(sp("2026-10-03", 9));
    expect(await closeGroupPoll(sdb, provider, { postId: late.id, now: sp("2026-10-04", 12) })).toEqual({ skipped: "fora_da_janela" });
    const sunday = await db.select().from(schema.outboxEvents).where(and(eq(schema.outboxEvents.eventType, "wa.group_poll_close"), eq(schema.outboxEvents.dedupeKey, `wa.group_poll_close:${late.id}:2026-10-04`)));
    expect(sunday[0]?.nextAttemptAt).toEqual(sp("2026-10-05", 9));
    expect(await closeGroupPoll(sdb, provider, { postId: "00000000-0000-4000-8000-000000000000" })).toEqual({ skipped: "inexistente" });
  });

  it("slug do Provador por ritual e dia", () => {
    expect(provadorSlug("chegadas", "2026-09-22")).toBe("prov-20260922-chegadas");
    expect(provadorSlug("quem_vestiu", "2026-09-26")).toBe("prov-20260926-vestiu");
    expect(provadorSlug("livre", "2026-09-26")).toBe("prov-20260926-post");
  });
});
