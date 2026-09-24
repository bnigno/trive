// "Me ajuda a escolher?": a rodada nasce na conversa (idempotente pelo turno),
// quem recebe vota uma vez por aparelho e pode deixar recado depois do voto,
// o resumo sai 10 min depois do primeiro voto, o fechamento traz o resultado
// e os recados que faltavam, SAIR encerra, e tudo some em 30 dias. Quem votou
// e quer ver peças abre o WhatsApp dela com a Lia (origem "amigas").
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeMessagingProvider } from "@/adapters/zapi/fake";
import { ANSWER_RETENTION_MS, ROUND_MAX_VOTES, SUMMARY_DELAY_MS } from "@/core/friends/decision";
import * as schema from "@/db/schema";
import { initialWaTemplates } from "@/db/seed-data";
import type { DbOrTx } from "@/queue/enqueue";
import { cardRenderPayloadSchema } from "@/services/bot-cards";
import { execPedirOpiniaoDasAmigas, turnToolsFor } from "@/services/bot/friends";
import type { CardRequest, ExecutorCtx } from "@/services/bot/shared";
import {
  addNoteToVote,
  cancelFriendRoundsForConversation,
  closeFriendRound,
  createDecisionRound,
  friendRoundMemoryLines,
  getPublicRound,
  openRoundBridge,
  purgeFriendRound,
  roundCreateKey,
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
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://cdn.test");
  await db.insert(schema.settings).values([
    { key: "wa_enabled", value: true },
    // Só dígitos em jsonb volta como número: a dona digita formatado.
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

async function seedProducts() {
  const a = await createTestVariant(db, { sku: "KIMONO-M", name: "Kimono Maré" });
  const b = await createTestVariant(db, { sku: "DUNAS-M", name: "Longo Dunas" });
  return { a, b };
}

async function seedRound(createKey = "turn:msg-1") {
  const { a, b } = await seedProducts();
  const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591999990001", status: "open" }).returning();
  const round = await createDecisionRound(sdb, {
    conversationId: conversation.id,
    createKey,
    displayName: "Ana Paula Ferreira",
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
  it("nasce com o primeiro nome, o fechamento agendado e o MESMO link no retry do turno", async () => {
    const { round, conversation } = await seedRound();
    expect(round.displayName).toBe("Ana");
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

  it("a chave muda com as peças: outra escolha no mesmo turno é outra rodada", () => {
    const one = roundCreateKey("msg-1", [{ productId: "p1", detail: null }, { productId: "p2", detail: null }]);
    const other = roundCreateKey("msg-1", [{ productId: "p1", detail: null }, { productId: "p3", detail: null }]);
    expect(one).not.toBe(other);
    expect(one).toBe(roundCreateKey("msg-1", [{ productId: "p1", detail: null }, { productId: "p2", detail: null }]));
  });

  it("a página pública mostra as letras, o prazo e o placar zerado; token inválido = nada", async () => {
    const { round } = await seedRound();
    const view = await getPublicRound(sdb, round.token, NOW);
    expect(view).toMatchObject({ displayName: "Ana", open: true, closesLabel: "amanhã às 12h", tally: { counts: [0, 0], total: 0, leader: null } });
    expect(view?.options.map((option) => `${option.letter} ${option.name}`)).toEqual(["A Kimono Maré", "B Longo Dunas"]);
    expect(await getPublicRound(sdb, "nao-existe-123", NOW)).toBeNull();
    expect(await getPublicRound(sdb, "../../etc", NOW)).toBeNull();
  });
});

describe("o voto e o recado", () => {
  it("um por aparelho; o recado vem depois do voto, sem link, telefone nem nome da loja", async () => {
    const { round } = await seedRound();
    expect(await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_A, now: NOW })).toMatchObject({ ok: true, tally: { counts: [0, 1], total: 1 } });
    // Toque repetido (em outra peça): vale o voto gravado, e o aparelho fica sabendo qual.
    expect(await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW })).toMatchObject({ ok: false, reason: "ja_votou", choice: 1 });
    expect(
      await addNoteToVote(sdb, { token: round.token, voterId: VOTER_A, note: "a B! paga aqui bit.ly/trive-pix ou 91 98888-7777 @loja_fake combina com teu cabelo", nickname: "Equipe TRIVÉ", now: NOW }),
    ).toEqual({ ok: true });
    const [answer] = await db.select().from(schema.friendAnswers);
    expect(answer.note).toBe("a B! paga aqui ou combina com teu cabelo");
    expect(answer.nickname).toBeNull();
    expect(answer.voterKey).toMatch(/^[0-9a-f]{64}$/);
    // Recado sem voto (outro aparelho) não entra; segundo recado do mesmo voto também não.
    expect(await addNoteToVote(sdb, { token: round.token, voterId: VOTER_B, note: "oi", now: NOW })).toEqual({ ok: false, reason: "sem_voto" });
    expect(await addNoteToVote(sdb, { token: round.token, voterId: VOTER_A, note: "de novo", now: NOW })).toEqual({ ok: false, reason: "ja_deixou" });
    const summaries = await outbox("friends.summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].nextAttemptAt.getTime()).toBe(NOW.getTime() + SUMMARY_DELAY_MS);
  });

  it("fechada, cheia ou opção fora da rodada não aceita voto", async () => {
    const { round } = await seedRound();
    expect(await voteInRound(sdb, { token: round.token, choice: 2, voterId: VOTER_A, now: NOW })).toMatchObject({ ok: false, reason: "opcao_invalida" });
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    expect(await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: later })).toMatchObject({ ok: false, reason: "fechada" });
    const [row] = await db.select().from(schema.friendRounds);
    await db.insert(schema.friendAnswers).values(
      Array.from({ length: ROUND_MAX_VOTES }, (_, index) => ({ roundId: row.id, voterKey: `k${index}`, choice: index % 2 })),
    );
    expect(await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW })).toMatchObject({ ok: false, reason: "cheia" });
  });
});

describe("o placar pela Lia", () => {
  it("resumo com placar, prazo e recado; fechamento com a mais votada e o recado que faltava; limpeza depois", async () => {
    const { round } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_A, now: NOW });
    await addNoteToVote(sdb, { token: round.token, voterId: VOTER_A, note: "combina com teu cabelo", nickname: "Carla", now: NOW });

    const at = new Date(NOW.getTime() + SUMMARY_DELAY_MS);
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: at })).toEqual({ sent: true });
    const summary = provider.sentMessages[0];
    expect(summary.toE164).toBe("+5591999990001");
    expect(summary.body).toContain("B, Longo Dunas (areia): 1 voto · A, Kimono Maré: 0 votos");
    expect(summary.body).toContain("Recados de quem votou:\n💬 Carla (B): combina com teu cabelo");
    expect(summary.body).toContain("aberta até amanhã às 12h");
    expect(summary.body).toContain(round.url);

    // Recado depois do resumo: vai no fechamento (e o de antes não repete).
    await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_B, now: at });
    await addNoteToVote(sdb, { token: round.token, voterId: VOTER_B, note: "a B sem dúvida", now: at });
    const end = new Date(NOW.getTime() + 24 * 3600_000);
    expect(await closeFriendRound(sdb, provider, { roundId: round.roundId, now: end })).toEqual({ sent: true });
    const closing = provider.sentMessages[1].body;
    expect(closing).toContain("A mais votada foi a B: Longo Dunas (areia)");
    expect(closing).toContain("💬 Alguém (B): a B sem dúvida");
    expect(closing).not.toContain("Carla");
    // Reentrega do fechamento: nada em dobro.
    await closeFriendRound(sdb, provider, { roundId: round.roundId, now: end });
    expect(provider.sentMessages).toHaveLength(2);
    expect(await outbox("friends.purge")).toHaveLength(1);
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: end })).toEqual({ skipped: "fechada" });

    expect(await purgeFriendRound(sdb, { roundId: round.roundId })).toEqual({ deleted: 2 });
    expect(await db.select().from(schema.friendAnswers)).toHaveLength(0);
    expect((await db.select().from(schema.friendRounds))[0].displayName).toBe("cliente");
    expect(await getPublicRound(sdb, round.token, new Date(end.getTime() + ANSWER_RETENTION_MS + 60_000))).toBeNull();
  });

  it("sem votos: o fechamento não festeja", async () => {
    const { round } = await seedRound();
    await closeFriendRound(sdb, provider, { roundId: round.roundId, now: new Date(NOW.getTime() + 24 * 3600_000) });
    expect(provider.sentMessages[0].body).toBe("A votação da sua dúvida acabou.\n\nNinguém votou a tempo. Se quiser, eu te ajudo a escolher por aqui.");
  });

  it("fora da janela de envio (madrugada) o resumo espera o horário", async () => {
    const { round } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW });
    const night = new Date("2026-10-06T03:00:00.000Z"); // meia-noite em SP
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: night })).toEqual({ skipped: "fora_da_janela" });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("SAIR encerra a votação: nem resumo nem resultado, e a limpeza fica agendada", async () => {
    const { round, conversation } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW });
    expect(await cancelFriendRoundsForConversation(sdb, { conversationId: conversation.id, now: NOW })).toBe(1);
    expect(await sendRoundSummary(sdb, provider, { roundId: round.roundId, now: NOW })).toEqual({ skipped: "cancelada" });
    expect(await closeFriendRound(sdb, provider, { roundId: round.roundId, now: new Date(NOW.getTime() + 24 * 3600_000) })).toEqual({ skipped: "cancelada" });
    expect(provider.sentMessages).toHaveLength(0);
    expect(await outbox("friends.purge")).toHaveLength(1);
    expect(await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_B, now: NOW })).toMatchObject({ ok: false, reason: "fechada" });
  });

  it("SAIR depois de a votação fechar de noite: o resultado adiado para a manhã não sai", async () => {
    const { round, conversation } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 0, voterId: VOTER_A, now: NOW });
    const night = new Date("2026-10-07T01:00:00.000Z"); // 22h em SP: fecha e adia
    expect(await closeFriendRound(sdb, provider, { roundId: round.roundId, now: night })).toEqual({ skipped: "fora_da_janela" });
    expect(await cancelFriendRoundsForConversation(sdb, { conversationId: conversation.id, now: night })).toBe(1);
    const morning = new Date("2026-10-07T12:00:00.000Z");
    expect(await closeFriendRound(sdb, provider, { roundId: round.roundId, now: morning })).toEqual({ skipped: "cancelada" });
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("o fechamento leva até 5 recados pendentes", async () => {
    const { round } = await seedRound();
    const voters = ["a", "b", "c", "d", "e", "f"].map((letter) => `${letter.repeat(8)}-aaaa-4aaa-8aaa-${letter.repeat(12)}`);
    for (const [index, voterId] of voters.entries()) {
      await voteInRound(sdb, { token: round.token, choice: index % 2, voterId, now: NOW });
      await addNoteToVote(sdb, { token: round.token, voterId, note: `recado ${index + 1}`, now: NOW });
    }
    await closeFriendRound(sdb, provider, { roundId: round.roundId, now: new Date(NOW.getTime() + 24 * 3600_000) });
    const body = provider.sentMessages[0].body;
    expect((body.match(/💬/g) ?? []).length).toBe(5);
  });

  it("o caderninho da Lia sabe a vencedora com o slug", async () => {
    const { round, conversation } = await seedRound();
    await voteInRound(sdb, { token: round.token, choice: 1, voterId: VOTER_A, now: NOW });
    const open = await friendRoundMemoryLines(sdb, { conversationId: conversation.id, now: NOW });
    expect(open[0]).toContain("Votação das amigas aberta até amanhã às 12h");
    expect(open[0]).toContain(round.url);
    const closed = await friendRoundMemoryLines(sdb, { conversationId: conversation.id, now: new Date(NOW.getTime() + 25 * 3600_000) });
    expect(closed[0]).toContain("ganhou B = Longo Dunas (areia) (dunas-m)");
  });
});

describe("quem votou e quer ver peças", () => {
  it("abre o WhatsApp DELA com a Lia (origem amigas) e a Lia sabe de qual votação veio", async () => {
    const { round } = await seedRound();
    const { url } = await openRoundBridge(sdb, { token: round.token });
    expect(url).toContain("wa.me/5591981037536");
    expect(decodeURIComponent(url ?? "")).toContain("vim pela votação da Ana");
    const [bridge] = await db.select().from(schema.siteCarts);
    expect(bridge).toMatchObject({ source: "amigas", roundId: round.roundId });
    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591988887777", status: "open" }).returning();
    const state = await consumeSiteCartByCode(sdb, { code: bridge.code, conversationId: conversation.id, now: new Date() });
    expect(state?.sourceLabel).toBe("votação da Ana");
  });
});

describe("a ferramenta da Lia", () => {
  async function publishable() {
    const { a, b } = await seedProducts();
    for (const [index, product] of [a, b].entries()) {
      await db.insert(schema.priceVersions).values({
        productVariantId: product.variantId,
        versionNumber: 1,
        status: "active",
        priceCents: 8990 + index * 1000,
        origin: "initial",
        breakdown: {},
        costSnapshotCents: 1000,
        computedMarginRate: "0.3000",
        activatedAt: new Date(),
      });
      await db.insert(schema.productImages).values({ productId: product.productId, storagePath: `products/${product.productId}/0-full.webp`, sortOrder: 0 });
    }
    const [conversation] = await db.insert(schema.waConversations).values({ phoneE164: "+5591999990001", status: "open" }).returning();
    return conversation;
  }

  function ctxFor(conversationId: string, cards: CardRequest[]): ExecutorCtx {
    return {
      conversationId,
      phoneE164: "+5591999990001",
      customerId: null,
      lastInboundId: "33333333-3333-4333-8333-333333333333",
      now: NOW,
      turnLists: { count: 0 },
      emitCard: async (request: CardRequest) => {
        cards.push(request);
        return "queued";
      },
    } as unknown as ExecutorCtx;
  }

  it("desligada: some do cardápio do modelo e, se chamada, recusa", async () => {
    expect(await turnToolsFor(sdb)).not.toContain("pedir_opiniao_das_amigas");
    const conversation = await publishable();
    const result = await execPedirOpiniaoDasAmigas(sdb, ctxFor(conversation.id, []), { pecas: ["kimono-m", "dunas-m"], nome: "Ana", cliente_pediu: true });
    expect(result).toMatchObject({ ok: false });
    await db.insert(schema.settings).values({ key: "friends_vote_enabled", value: true });
    expect(await turnToolsFor(sdb)).toBeUndefined();
  });

  it("ligada: cria a votação e o cartão passa na validação do render (preço em cada peça)", async () => {
    await db.insert(schema.settings).values({ key: "friends_vote_enabled", value: true });
    const conversation = await publishable();
    const cards: CardRequest[] = [];
    const result = await execPedirOpiniaoDasAmigas(sdb, ctxFor(conversation.id, cards), { pecas: ["kimono-m", "dunas-m"], detalhes: ["", "areia"], nome: "Ana Paula", cliente_pediu: true });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('para "Ana"');
    expect(cards).toHaveLength(1);
    const items = cardRenderPayloadSchema.shape.request.shape.items.safeParse(cards[0].items);
    expect(items.success).toBe(true);
    expect(cards[0].title).toBe("Qual fica melhor na Ana?");
    expect(cards[0].caption).toContain("/v/");
  });
});
