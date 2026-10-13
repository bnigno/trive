// Boletim da Lia: em 04/10/2026 ela ficou 8 dias desligada sem ninguém notar —
// 277 mensagens encaminhadas e três clientes sem resposta de ninguém. Estes
// testes fixam o que o painel precisa mostrar para isso não repetir.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { getLiaBulletin, WAITING_ALERT_HOURS } from "@/services/wa-insights";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
});

afterEach(async () => {
  await close();
});

const horas = (n: number) => new Date(Date.now() - n * 3_600_000);

async function conversaCom(opts: {
  phone: string;
  ultimaDela: Date;
  ultimaNossa?: Date;
  status?: "open" | "human" | "closed";
  nome?: string;
  texto?: string;
}): Promise<string> {
  const [conversa] = await db
    .insert(schema.waConversations)
    .values({
      phoneE164: opts.phone,
      status: opts.status ?? "open",
      lastInboundAt: opts.ultimaDela,
      ...(opts.ultimaNossa ? { lastOutboundAt: opts.ultimaNossa } : {}),
      ...(opts.nome ? { botState: { displayName: opts.nome } } : {}),
    })
    .returning({ id: schema.waConversations.id });
  await db.insert(schema.waMessages).values({
    conversationId: conversa.id,
    direction: "inbound",
    kind: "text",
    body: opts.texto ?? "oi",
    zapiMessageId: `z-${opts.phone}-${opts.ultimaDela.getTime()}`,
    dedupeKey: `d-${opts.phone}-${opts.ultimaDela.getTime()}`,
    status: "delivered",
    createdAt: opts.ultimaDela,
  });
  return conversa.id;
}

describe("getLiaBulletin", () => {
  it("avisa que a Lia está desligada, desde quando e quantas foram para a dona", async () => {
    const desligadaEm = horas(72);
    await db.insert(schema.settings).values({ key: "bot_enabled", value: false, updatedAt: desligadaEm });
    await db.insert(schema.outboxEvents).values([
      { eventType: "wa.owner_forward", dedupeKey: "f1", aggregateType: "wa_conversation", aggregateId: crypto.randomUUID(), payload: {}, createdAt: horas(48) },
      { eventType: "wa.owner_forward", dedupeKey: "f2", aggregateType: "wa_conversation", aggregateId: crypto.randomUUID(), payload: {}, createdAt: horas(2) },
      // Antes de desligar: não conta para o período de silêncio.
      { eventType: "wa.owner_forward", dedupeKey: "f0", aggregateType: "wa_conversation", aggregateId: crypto.randomUUID(), payload: {}, createdAt: horas(200) },
    ]);

    const boletim = await getLiaBulletin(sdb);

    expect(boletim.muted).not.toBeNull();
    expect(boletim.muted?.since?.getTime()).toBe(desligadaEm.getTime());
    expect(boletim.muted?.forwardedSince).toBe(2);
  });

  it("ligada, não avisa nada", async () => {
    await db.insert(schema.settings).values({ key: "bot_enabled", value: true });
    expect((await getLiaBulletin(sdb)).muted).toBeNull();
  });

  it("lista quem falou por último e ficou sem resposta, da mais antiga para a mais nova", async () => {
    await db.insert(schema.settings).values({ key: "bot_enabled", value: true });
    // Esperando há muito: é a que mais dói.
    await conversaCom({ phone: "+5591900000001", ultimaDela: horas(100), nome: "Kayllane", texto: "Ainda tem o bory?" });
    // Esperando há pouco, mas além do limite.
    await conversaCom({ phone: "+5591900000002", ultimaDela: horas(WAITING_ALERT_HOURS + 1), texto: "Ta de quanto um" });
    // Respondida DEPOIS de falar: não está esperando.
    await conversaCom({ phone: "+5591900000003", ultimaDela: horas(50), ultimaNossa: horas(49) });
    // Falou agora: dentro do prazo, ninguém se assusta.
    await conversaCom({ phone: "+5591900000004", ultimaDela: horas(0) });
    // Conversa encerrada: ali o silêncio é decisão, não esquecimento.
    await conversaCom({ phone: "+5591900000005", ultimaDela: horas(80), status: "closed" });

    const { waiting } = await getLiaBulletin(sdb);

    expect(waiting.map((c) => c.phoneE164)).toEqual(["+5591900000002", "+5591900000001"]);
    const antiga = waiting[1];
    expect(antiga.displayName).toBe("Kayllane");
    expect(antiga.preview).toBe("Ainda tem o bory?");
    expect(antiga.hoursWaiting).toBeGreaterThanOrEqual(99);
  });

  it("conta os turnos que falharam calado", async () => {
    await db.insert(schema.settings).values({ key: "bot_enabled", value: true });
    const conversationId = await conversaCom({ phone: "+5591900000009", ultimaDela: horas(1) });
    const turno = (after: Record<string, unknown>) => ({
      actorType: "system" as const,
      action: "wa.bot_turn",
      entityType: "wa_conversation",
      entityId: conversationId,
      after,
    });
    await db.insert(schema.auditLog).values([
      turno({ bubbles: 0, handedOff: false }),
      turno({ bubbles: 2, handedOff: true }),
      turno({ bubbles: 1, handedOff: false, assertedWithoutTool: true }),
      turno({ bubbles: 1, handedOff: false, assertedWithoutTool: false }),
    ]);

    const boletim = await getLiaBulletin(sdb);

    expect(boletim.turnsWithoutReply).toBe(1);
    // Marcou que passou para humano, mas não há wa.bot_handoff nenhum.
    expect(boletim.promisedHumanWithoutHandoff).toBe(1);
    expect(boletim.assertedWithoutTool).toBe(1);
  });
});
