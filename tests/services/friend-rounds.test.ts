// "Me ajuda a escolher?": a rodada nasce na conversa (idempotente pelo turno),
// as amigas votam uma vez por aparelho, o resumo sai 10 min depois do
// primeiro voto, o fechamento traz o resultado e os votos somem em 30 dias.
// A amiga que quer ver peças abre o WhatsApp dela com a Lia (origem "amigas").
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { SUMMARY_DELAY_MS } from "@/core/friends/decision";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import {
  closeFriendRound,
  createDecisionRound,
  getPublicRound,
  openRoundBridge,
  purgeFriendRound,
  sendRoundSummary,
  voteInRound,
} from "@/services/friend-rounds";
import { consumeSiteCartByCode } from "@/services/site-carts";
import { createTestDb, createTestVariant, type TestDb } from "../helpers/db";

const NOW = new Date("2026-10-05T15:00:00.000Z"); // 12h em São Paulo
const VOTER_A = "11111111-1111-4111-8111-111111111111";
const VOTER_B = "22222222-2222-4222-8222-222222222222";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let provider: FakeMessagingProvider;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  provider = new FakeMessagingProvider();
  vi.stubEnv("ADAPTER_MODE", "fake");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    { key: "store_whatsapp", value: "(91) 98103-7536" },
  ]);
  await db.insert(schema.waTemplates).values(
    initialWaTemplates
      .filter((template) => template.key.startsWith("friends_"))
      .map((template) => ({ key: template.key, label: template.label, bodyTemplate: template.bodyTemplate, variables: template.variables })),
  );
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function seedRound(createKey = "turn:msg-1") {
  const a = await createTestVariant(db, { sku: "KIMONO-M", name: "Kimono Maré" });
  const b = await createTestVariant(db, { sku: "DUNAS-M", name: "Longo Dunas" });
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591999990001", status: "open" }).returning();
  const round = await createDecisionRound(sdb, {
    conversationId: conversation.id,
    createKey,
    displayName: "Ana",
    options: [
      { productId: a.productId, name: "Kimono Maré", detail: null, slug: "kimono-m", imagePath: null },
      { productId: b.productId, name: "Longo Dunas", detail: "areia", slug: "dunas-m", imagePath: null },
    ],
    now: NOW,
  });
  return { round, conversation };
}

const outbox = (type: string) => db.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.eventType, type));

describe("a rodada", () => {
  it("nasce com o fechamento agendado para 24 h e é a mesma no retry do turno", async () => {
    const { round, conversation } = await seedRound();
    const [closeEvent] = await outbox("friends.close");
    expect(closeEvent.nextAttemptAt.getTime()).toBe(NOW.getTime() + 24 * 3600_000);
    const again = await createDecisionRound(sdb, {
      conversationId: conversation.id,
      createKey: "turn:msg-1",
      displayName: "Ana",
      options: [
        { productId: round.roundId, name: "x", detail: null, slug: "x", imagePath: null },
        { productId: round.roundId, name: "y", detail: null, slug: "y", imagePath: null },
      ],
      now: NOW,
    });
    expect(again.token).toBe(round.token);
    expect(await db.select().from(schema.friendRounds)).toHaveLength(1);
    expect(round.url).toMatch(/\/v\/[A-Za-z0-9_-]{16}$/);
  });

  it("a página pública mostra as letras e o placar zerado; token inválido = nada", async () => {
    const { round } = await seedRound();
    const view = await getPublicRound(sdb, round.token, NOW);
    expect(view).toMatchObject({ displayName: "Ana", open: true, tally: { counts: [0, 0], total: 0, leader: null } });
    expect(view?.options.map((option) => `${option.letter} ${option.name}`)).toEqual(["A Kimono Maré", "B Longo Dunas"]);
    expect(await getPublicRound(sdb, "nao-existe-123", NOW)).toBeNull();
    expect(await getPublicRound(sdb, "../../etc", NOW)).toBeNull();
  });
});

describe("o voto", () => {
  it("um por aparelho; o recado perde o link; o resumo fica para 10 min depois do primeiro voto", async () => {
    const { round } = await seedRound();
    const first = await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_A, note: "a B! https://golpe.example combina com teu cabelo", nickname: "Carla", now: NOW });
    expect(first).toMatchObject({ ok: true, tally: { counts: [0, 1], total: 1 } });
    expect(await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW })).toMatchObject({ ok: false, reason: "ja_votou" });
    await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_B, now: new Date(NOW.getTime() + 60_000) });

    const [answer] = await db.select().from(schema.friendAnswers).where(eq(schema.friendAnswers.nickname, "Carla"));
    expect(answer.note).toBe("a B! combina com teu cabelo");
    expect(answer.voterKey).toMatch(/^[0-9a-f]{64}$/);
    const summaries = await outbox("friends.summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + SUMMARY_DELAY_MS);
  });

  it("fechada não aceita voto; opção fora da rodada também não", async () => {
    const { round } = await seedRound();
    expect(await voteInRound(sdb, { token: round.token, choice: 2, voterId: VOTER_A, now: NOW })).toMatchObject({ ok: false, reason: "opcao_invalida" });
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    expect(await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: later })).toMatchObject({ ok: false, reason: "fechada" });
  });
});

describe("o placar pela Lia", () => {
  it("resumo com o placar e o recado; fechamento com a vencedora e a pergunta de separar; limpeza depois", async () => {
    const { round } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_A, note: "combina com teu cabelo", nickname: "Carla", now: NOW });
    await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_B, now: NOW });

    const at = new Date(NOW.getTime() + SUMMARY_DELAY_MS);
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: at })).toEqual({ sent: true });
    const summary = provider.sentMessages[0];
    expect(summary.toE164).toBe("+5591999990001");
    expect(summary.body).toContain("B, Longo Dunas (areia): 2 votos · A, Kimono Maré: 0 votos");
    expect(summary.body).toContain("💬 Carla (B): combina com teu cabelo");
    expect(summary.body).toContain(round.url);

    const end = new Date(NOW.getTime() + 24 * 3600_000);
    expect(await closeFriendRound(sdb, provider, { roundId: round.roundId, now: end })).toEqual({ sent: true });
    expect(provider.sentMessages[1].body).toContain("Suas amigas escolheram a B: Longo Dunas (areia)");
    expect((await db.select().from(schema.friendRounds))[0].closedAt).not.toBeNull();
    // Reentrega do fechamento: nada em dobro.
    await closeFriendRound(sdb, provider, { roundId: round.roundId, now: end });
    expect(provider.sentMessages).toHaveLength(2);
    expect(await outbox("friends.purge")).toHaveLength(1);
    // Resumo atrasado depois de fechar: não sai.
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: end })).toEqual({ skipped: "fechada" });

    expect(await purgeFriendRound(sdb, { roundId: round.roundId })).toEqual({ deleted: 2 });
    expect(await db.select().from(schema.friendAnswers)).toHaveLength(0);
  });

  it("fora da janela de envio (madrugada) o resumo espera o horário", async () => {
    const { round } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW });
    const night = new Date("2026-10-06T03:00:00.000Z"); // meia-noite em SP
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: night })).toEqual({ skipped: "fora_da_janela" });
    expect(provider.sentMessages).toHaveLength(0);
  });
});

describe("a amiga que quer ver peças", () => {
  it("abre o WhatsApp DELA com a Lia (origem amigas) e a Lia sabe de quem era a dúvida", async () => {
    const { round } = await seedRound();
    const { url } = await openRoundBridge(sdb, { token: round.token });
    expect(url).toContain("wa.me/5591981037536");
    expect(decodeURIComponent(url ?? "")).toContain("votei na dúvida da Ana");
    const [bridge] = await db.select().from(schema.siteCarts);
    expect(bridge).toMatchObject({ source: "amigas", roundId: round.roundId });
    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591988887777", status: "open" }).returning();
    const state = await consumeSiteCartByCode(sdb, { code: bridge.code, conversationId: conversation.id, now: new Date() });
    expect(state?.sourceLabel).toBe("votou na dúvida da Ana");
  });
});
