// A nota da curadora: o áudio sobe, a transcrição preenche o texto e a dona
// corrige. Vendor fora do ar não perde a gravação; regravar troca o arquivo.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeTranscriber } from "@/adapters/transcription/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import {
  recordCuratorNote,
  removeCuratorAudio,
  updateCuratorNote,
} from "@/services/curator-notes";
import { ServiceError } from "@/services/settings";
import { createTestDb, createTestVariant, FIXED_USER_ID, type TestDb } from "../helpers/db";

let db: TestDb;
let sdb: DbOrTx;
let close: () => Promise<void>;
let storage: FakeFileStorage;
let transcriber: FakeTranscriber;

const AUDIO = { data: Buffer.from("áudio de teste"), contentType: "audio/webm;codecs=opus" };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sdb = db as unknown as DbOrTx;
  storage = new FakeFileStorage();
  transcriber = new FakeTranscriber();
  vi.stubEnv("ADAPTER_MODE", "fake");
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
});

async function product(): Promise<string> {
  const { productId } = await createTestVariant(db, { sku: "DUNAS", name: "Longo Dunas" });
  return productId;
}

async function row(productId: string) {
  const [found] = await db
    .select({
      note: schema.products.curatorNote,
      path: schema.products.curatorAudioPath,
      mime: schema.products.curatorAudioMime,
      seconds: schema.products.curatorAudioSeconds,
      updatedAt: schema.products.curatorNoteUpdatedAt,
    })
    .from(schema.products)
    .where(eq(schema.products.id, productId));
  return found;
}

async function audits(productId: string): Promise<string[]> {
  const rows = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, productId));
  return rows.map((entry) => entry.action);
}

describe("recordCuratorNote", () => {
  it("sobe o áudio, transcreve e guarda texto, formato e duração — com audit", async () => {
    const productId = await product();
    transcriber.enqueueText("  É um linho   que respira no calor.  ");

    const result = await recordCuratorNote(sdb, storage, transcriber, {
      productId,
      userId: FIXED_USER_ID,
      audio: { ...AUDIO, seconds: 32 },
    });

    expect(result.transcribed).toBe(true);
    expect(result.note).toBe("É um linho que respira no calor.");
    expect(result.audioPath).toMatch(/^products\/.+\/nota-curadora-.+\.webm$/);
    expect(storage.has(result.audioPath)).toBe(true);

    const saved = await row(productId);
    expect(saved.note).toBe("É um linho que respira no calor.");
    expect(saved.path).toBe(result.audioPath);
    expect(saved.mime).toBe("audio/webm;codecs=opus");
    expect(saved.seconds).toBe(32);
    expect(saved.updatedAt).toBeInstanceOf(Date);

    // O que foi para o vendor: o áudio e a dica de idioma.
    expect(transcriber.calls[0].languageHint).toBe("pt");
    expect(await audits(productId)).toContain("product.curator_note_recorded");
  });

  it("vendor fora do ar: o áudio fica salvo e o texto continua para a dona escrever", async () => {
    const productId = await product();
    transcriber.failNext();

    const result = await recordCuratorNote(sdb, storage, transcriber, {
      productId,
      userId: FIXED_USER_ID,
      audio: AUDIO,
    });

    expect(result.transcribed).toBe(false);
    expect(result.note).toBeNull();
    expect(storage.has(result.audioPath)).toBe(true);
    expect((await row(productId)).path).toBe(result.audioPath);
  });

  it("regravar troca o arquivo e apaga o anterior do bucket", async () => {
    const productId = await product();
    transcriber.enqueueText("primeira nota");
    const first = await recordCuratorNote(sdb, storage, transcriber, {
      productId,
      userId: FIXED_USER_ID,
      audio: AUDIO,
    });
    transcriber.enqueueText("nota refeita");
    const second = await recordCuratorNote(sdb, storage, transcriber, {
      productId,
      userId: FIXED_USER_ID,
      audio: AUDIO,
    });

    expect(second.audioPath).not.toBe(first.audioPath);
    expect(storage.has(first.audioPath)).toBe(false);
    expect(storage.has(second.audioPath)).toBe(true);
    expect((await row(productId)).note).toBe("nota refeita");
  });

  it("recusa formato que não é áudio, arquivo grande e gravação longa — sem subir nada", async () => {
    const productId = await product();
    await expect(
      recordCuratorNote(sdb, storage, transcriber, {
        productId,
        userId: FIXED_USER_ID,
        audio: { data: Buffer.from("x"), contentType: "video/mp4" },
      }),
    ).rejects.toThrow(/formato de áudio/);

    await expect(
      recordCuratorNote(sdb, storage, transcriber, {
        productId,
        userId: FIXED_USER_ID,
        audio: { data: Buffer.alloc(4 * 1024 * 1024), contentType: "audio/webm" },
      }),
    ).rejects.toThrow(/grande demais/);

    await expect(
      recordCuratorNote(sdb, storage, transcriber, {
        productId,
        userId: FIXED_USER_ID,
        audio: { ...AUDIO, seconds: 90 },
      }),
    ).rejects.toThrow(/60 segundos/);

    expect(transcriber.calls).toHaveLength(0);
    expect((await row(productId)).path).toBeNull();
  });

  it("peça inexistente é recusada", async () => {
    await expect(
      recordCuratorNote(sdb, storage, transcriber, {
        productId: "00000000-0000-4000-8000-000000000abc",
        userId: FIXED_USER_ID,
        audio: AUDIO,
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("updateCuratorNote / removeCuratorAudio", () => {
  it("a dona corrige o texto; vazio tira a nota", async () => {
    const productId = await product();
    transcriber.enqueueText("texto da transcrição");
    await recordCuratorNote(sdb, storage, transcriber, {
      productId,
      userId: FIXED_USER_ID,
      audio: AUDIO,
    });

    const fixed = await updateCuratorNote(sdb, {
      productId,
      userId: FIXED_USER_ID,
      note: "  Texto   corrigido pela dona. ",
    });
    expect(fixed.note).toBe("Texto corrigido pela dona.");
    expect((await row(productId)).note).toBe("Texto corrigido pela dona.");

    await updateCuratorNote(sdb, { productId, userId: FIXED_USER_ID, note: "   " });
    expect((await row(productId)).note).toBeNull();
    expect(await audits(productId)).toContain("product.curator_note_updated");
  });

  it("remover o áudio mantém o texto; sem áudio, não faz nada", async () => {
    const productId = await product();
    transcriber.enqueueText("a nota falada");
    const recorded = await recordCuratorNote(sdb, storage, transcriber, {
      productId,
      userId: FIXED_USER_ID,
      audio: AUDIO,
    });

    expect(await removeCuratorAudio(sdb, storage, { productId, userId: FIXED_USER_ID })).toEqual({
      removed: true,
    });
    const saved = await row(productId);
    expect(saved.path).toBeNull();
    expect(saved.mime).toBeNull();
    expect(saved.note).toBe("a nota falada");
    expect(storage.has(recorded.audioPath)).toBe(false);

    expect(await removeCuratorAudio(sdb, storage, { productId, userId: FIXED_USER_ID })).toEqual({
      removed: false,
    });
  });
});
