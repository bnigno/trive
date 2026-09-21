// As tabelas do Provador (migração 0048) com o banco de verdade (PGlite):
// os árbitros de duplicata e as CHECKs são contrato — é neles que a fila e
// o webhook se apoiam para nunca duplicar sinal nem post.
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { initialSettings } from "@/db/seed-data";
import { ALLOWED_SETTING_KEYS } from "@/services/settings";
import { createTestDb, type TestDb } from "../helpers/db";

const GROUP = "120363019502650977-group";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function createGroup(): Promise<string> {
  const [group] = await db
    .insert(schema.waGroups)
    .values({ providerGroupId: GROUP, name: "Provador TRIVÉ" })
    .returning({ id: schema.waGroups.id });
  return group.id;
}

describe("schema do Provador (wa_groups, membras, posts, sinais)", () => {
  it("uma sala por id de grupo da Z-API; kind e member_count têm CHECK", async () => {
    await createGroup();
    await expect(
      db.insert(schema.waGroups).values({ providerGroupId: GROUP, name: "outra" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waGroups).values({ providerGroupId: "1-group", name: "x", kind: "clube" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waGroups).values({ providerGroupId: "2-group", name: "x", memberCount: -1 }),
    ).rejects.toThrow();
  });

  it("uma linha por (sala, endereço) em membras; voltar a entrar é UPDATE, não linha nova", async () => {
    const groupId = await createGroup();
    await db.insert(schema.waGroupMembers).values({ groupId, phoneE164: "+5591999991528", source: "lia" });
    await expect(
      db.insert(schema.waGroupMembers).values({ groupId, phoneE164: "+5591999991528", source: "sync" }),
    ).rejects.toThrow();
    // LID é endereço como outro.
    await db.insert(schema.waGroupMembers).values({ groupId, phoneE164: "220839349862480@lid" });
    await expect(
      db.insert(schema.waGroupMembers).values({ groupId, phoneE164: "+5591999990000", source: "convite" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waGroupMembers).values({ groupId, phoneE164: "+5591999990001", leftReason: "cansou" }),
    ).rejects.toThrow();
  });

  it("post: dedupe_key único, kind/status/poll_max com CHECK, provider_message_id único quando existe", async () => {
    const groupId = await createGroup();
    await db.insert(schema.waGroupPosts).values({ groupId, kind: "chegadas", body: "Passou pelo Provador hoje", dedupeKey: "post:1" });
    await expect(
      db.insert(schema.waGroupPosts).values({ groupId, kind: "chegadas", body: "de novo", dedupeKey: "post:1" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waGroupPosts).values({ groupId, kind: "promo", body: "x", dedupeKey: "post:2" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waGroupPosts).values({ groupId, kind: "livre", status: "sending", body: "x", dedupeKey: "post:3" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.waGroupPosts).values({ groupId, kind: "enquete", body: "x", dedupeKey: "post:4", pollOptions: ["A", "B"], pollMaxOptions: 13 }),
    ).rejects.toThrow();
    // Dois posts ainda não enviados não colidem (provider_message_id nulo); enviados, sim.
    await db.insert(schema.waGroupPosts).values({ groupId, kind: "livre", body: "a", dedupeKey: "post:5", providerMessageId: "M-1" });
    await db.insert(schema.waGroupPosts).values({ groupId, kind: "livre", body: "b", dedupeKey: "post:6" });
    await expect(
      db.insert(schema.waGroupPosts).values({ groupId, kind: "livre", body: "c", dedupeKey: "post:7", providerMessageId: "M-1" }),
    ).rejects.toThrow();
  });

  it("sinais: o último voto/reação da pessoa vale (upsert por mensagem+pessoa+tipo); votar E reagir à mesma enquete são dois sinais", async () => {
    const groupId = await createGroup();
    const base = { groupId, participantPhone: "+5591999991528", referencedMessageId: "POLL-1" };
    await db.insert(schema.waGroupSignals).values({ ...base, kind: "poll_vote", value: '["Vinho"]', providerMessageId: "V-1" });
    // Segundo voto da mesma pessoa na mesma enquete: colide no índice → o serviço faz upsert.
    await expect(
      db.insert(schema.waGroupSignals).values({ ...base, kind: "poll_vote", value: '["Verde"]', providerMessageId: "V-2" }),
    ).rejects.toThrow();
    await db
      .insert(schema.waGroupSignals)
      .values({ ...base, kind: "poll_vote", value: '["Verde"]', providerMessageId: "V-2" })
      .onConflictDoUpdate({
        target: [schema.waGroupSignals.referencedMessageId, schema.waGroupSignals.participantPhone, schema.waGroupSignals.kind],
        // Índice parcial: o arbítrio precisa do predicado (targetWhere, não where — que é o do UPDATE).
        targetWhere: sql`${schema.waGroupSignals.kind} IN ('poll_vote', 'reaction')`,
        set: { value: '["Verde"]', providerMessageId: "V-2" },
      });
    // Reação à mesma mensagem, mesma pessoa: outro tipo, outra linha.
    await db.insert(schema.waGroupSignals).values({ ...base, kind: "reaction", value: "❤️", providerMessageId: "R-1" });
    const rows = await db.select().from(schema.waGroupSignals);
    expect(rows.map((row) => [row.kind, row.value]).sort()).toEqual([
      ["poll_vote", '["Verde"]'],
      ["reaction", "❤️"],
    ]);
  });

  it("sinais: menção e mensagem não duplicam no replay do webhook (provider_message_id + kind)", async () => {
    const groupId = await createGroup();
    const base = { groupId, participantPhone: "+5591999991528", providerMessageId: "MSG-1" };
    await db.insert(schema.waGroupSignals).values({ ...base, kind: "mention", value: "@Lia tem em M?" });
    await expect(db.insert(schema.waGroupSignals).values({ ...base, kind: "mention", value: "@Lia tem em M?" })).rejects.toThrow();
    await expect(db.insert(schema.waGroupSignals).values({ ...base, kind: "curtida" })).rejects.toThrow();
  });

  it("apagar a sala leva membras, posts e sinais junto (cascade)", async () => {
    const groupId = await createGroup();
    await db.insert(schema.waGroupMembers).values({ groupId, phoneE164: "+5591999991528" });
    const [post] = await db
      .insert(schema.waGroupPosts)
      .values({ groupId, kind: "livre", body: "x", dedupeKey: "post:c" })
      .returning({ id: schema.waGroupPosts.id });
    await db.insert(schema.waGroupSignals).values({ groupId, postId: post.id, participantPhone: "+5591999991528", kind: "message", providerMessageId: "M-c" });
    await db.execute(sql`delete from wa_groups`);
    expect(await db.select().from(schema.waGroupMembers)).toHaveLength(0);
    expect(await db.select().from(schema.waGroupPosts)).toHaveLength(0);
    expect(await db.select().from(schema.waGroupSignals)).toHaveLength(0);
  });

  it("settings do Provador: semeados desligados, dentro das chaves permitidas", () => {
    const seeded = Object.fromEntries(initialSettings.map((s) => [s.key, s.value]));
    expect(seeded["groups_enabled"]).toBe(false);
    expect(seeded["bot_group_mentions_enabled"]).toBe(false);
    expect(seeded["group_posts_per_week"]).toBe(3);
    expect(seeded["group_kill_switch_pct"]).toBe(2);
    for (const key of ["groups_enabled", "bot_group_mentions_enabled", "group_posts_per_week", "group_kill_switch_pct"]) {
      expect(ALLOWED_SETTING_KEYS).toContain(key);
    }
  });
});
