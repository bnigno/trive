// A nota da curadora: o áudio sobe (com o mime canônico que o bucket aceita),
// a transcrição preenche o texto e a dona corrige. Vendor fora do ar não perde
// a gravação; regravar troca o arquivo; silêncio não vira nota; o audit guarda
// o texto inteiro para recuperar uma correção sobrescrita.
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { FakeTranscriber } from "@/adapters/transcription/fake";
import { CURATOR_NOTE_MAX_CHARS } from "@/core/catalog/curator-note";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { ServiceError } from "@/services/catalog";
import {
  recordCuratorNote,
  removeCuratorAudio,
  updateCuratorNote,
} from "@/services/curator-notes";
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function product(sku = "DUNAS"): Promise<string> {
  const { productId } = await createTestVariant(db, { sku, name: "Longo Dunas" });
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

async function audits(productId: string) {
  return db
    .select({ action: schema.auditLog.action, before: schema.auditLog.before, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.entityId, productId))
    .orderBy(desc(schema.auditLog.createdAt));
}

const record = (
  productId: string,
  audio = AUDIO as { data: Buffer; contentType: string; originalContentType?: string; seconds?: number },
) =>
  recordCuratorNote(sdb, storage, transcriber, { productId, userId: FIXED_USER_ID, audio });

describe("recordCuratorNote", () => {
  it("sobe o áudio com o mime canônico, transcreve e guarda texto, formato e duração — com audit do texto", async () => {
    const productId = await product();
    transcriber.enqueueText("  É um linho   que respira no calor.  ");

    const result = await record(productId, { ...AUDIO, seconds: 32 });

    expect(result).toMatchObject({ transcribed: true, truncated: false, reason: "ok", staleNote: false });
    expect(result.note).toBe("É um linho que respira no calor.");
    expect(result.audioPath).toMatch(/^products\/.+\/nota-curadora-.+\.webm$/);
    // O bucket compara o mime por igualdade: vai "audio/webm", não o valor com codecs.
    expect(storage.get(result.audioPath)?.contentType).toBe("audio/webm");
    expect(storage.list()).toEqual([result.audioPath]);

    const saved = await row(productId);
    expect(saved.note).toBe("É um linho que respira no calor.");
    expect(saved.path).toBe(result.audioPath);
    expect(saved.mime).toBe("audio/webm");
    expect(saved.seconds).toBe(32);
    expect(saved.updatedAt).toBeInstanceOf(Date);

    // O que foi para o vendor: o áudio, o mime canônico e a dica de idioma.
    expect(transcriber.calls[0]).toMatchObject({ mimeType: "audio/webm", languageHint: "pt" });
    expect(transcriber.calls[0].data.equals(AUDIO.data)).toBe(true);

    const [audit] = await audits(productId);
    expect(audit.action).toBe("product.curator_note_recorded");
    expect(audit.before).toEqual({ note: null, audioPath: null });
    expect(audit.after).toMatchObject({
      note: "É um linho que respira no calor.",
      mime: "audio/webm",
      originalMime: "audio/webm;codecs=opus",
      seconds: 32,
      transcribed: true,
      reason: "ok",
      model: "fake-transcribe",
    });
  });

  it("os apelidos do iPhone e do Android entram no formato certo", async () => {
    const productId = await product();
    transcriber.enqueueText("nota");
    const m4a = await record(productId, { data: Buffer.from("aac"), contentType: "audio/x-m4a" });
    expect(m4a.audioPath.endsWith(".m4a")).toBe(true);
    expect((await row(productId)).mime).toBe("audio/mp4");
    transcriber.enqueueText("nota");
    const mp3 = await record(productId, { data: Buffer.from("mp3"), contentType: "audio/mp3" });
    expect(mp3.audioPath.endsWith(".mp3")).toBe(true);
    expect((await row(productId)).mime).toBe("audio/mpeg");
  });

  it("vendor fora do ar: o áudio fica salvo, o texto anterior fica (marcado como velho) e o motivo vai para o log e o audit", async () => {
    const productId = await product();
    transcriber.enqueueText("Linho puro");
    await record(productId);

    transcriber.failNext("HTTP 401", "rejected");
    const result = await record(productId);

    expect(result).toMatchObject({ transcribed: false, reason: "rejected", staleNote: true, note: "Linho puro" });
    expect(storage.has(result.audioPath)).toBe(true);
    const saved = await row(productId);
    expect(saved.path).toBe(result.audioPath);
    expect(saved.note).toBe("Linho puro");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
    const [audit] = await audits(productId);
    expect(audit.after).toMatchObject({ transcribed: false, reason: "rejected", model: null, note: "Linho puro" });

    // Sem nota anterior, o texto fica vazio e não é "velho".
    const other = await product("OUTRA");
    transcriber.failNext("fora do ar", "unavailable");
    expect(await record(other)).toMatchObject({ transcribed: false, note: null, staleNote: false, reason: "unavailable" });
  });

  it("silêncio (transcrição só de pontuação) não vira nota nem apaga a anterior", async () => {
    const productId = await product();
    transcriber.enqueueText("Linho puro");
    await record(productId);
    transcriber.enqueueText(" . ... ");
    const result = await record(productId);
    expect(result).toMatchObject({ transcribed: false, reason: "empty", staleNote: true, note: "Linho puro" });
    expect((await row(productId)).note).toBe("Linho puro");
    expect(storage.has(result.audioPath)).toBe(true);
  });

  it("fala maior que o teto é cortada na palavra e avisada", async () => {
    const productId = await product();
    transcriber.enqueueText(Array.from({ length: 400 }, () => "palavra").join(" "));
    const result = await record(productId);
    expect(result.transcribed).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.note!.length).toBeLessThanOrEqual(CURATOR_NOTE_MAX_CHARS);
    expect(result.note!.endsWith("palavra…")).toBe(true);
    const [audit] = await audits(productId);
    expect(audit.after).toMatchObject({ truncated: true });
  });

  it("regravar troca o arquivo e apaga o anterior do bucket; se apagar falhar, só avisa", async () => {
    const productId = await product();
    transcriber.enqueueText("primeira nota");
    const first = await record(productId);
    transcriber.enqueueText("nota refeita");
    const second = await record(productId);

    expect(second.audioPath).not.toBe(first.audioPath);
    expect(storage.has(first.audioPath)).toBe(false);
    expect(storage.has(second.audioPath)).toBe(true);
    expect((await row(productId)).note).toBe("nota refeita");
    // O audit guarda o texto que foi sobrescrito.
    const [audit] = await audits(productId);
    expect(audit.before).toEqual({ note: "primeira nota", audioPath: first.audioPath });

    storage.remove = async () => {
      throw new Error("storage indisponível");
    };
    transcriber.enqueueText("terceira");
    const third = await record(productId);
    expect((await row(productId)).path).toBe(third.audioPath);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(second.audioPath), expect.anything());
  });

  it("upload recusado pelo repositório vira mensagem própria; nada é gravado nem transcrito", async () => {
    const productId = await product();
    storage.upload = async () => {
      throw new Error("mime type audio/webm is not supported");
    };
    const error = await record(productId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("audio_nao_guardado");
    expect((await row(productId)).path).toBeNull();
    expect(transcriber.calls).toHaveLength(0);
  });

  it("falha depois do upload (banco ou bug do transcritor) não deixa o áudio órfão no bucket e vai para o log", async () => {
    const productId = await product();
    transcriber.enqueueText("nota");
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("banco caiu"));
    await expect(record(productId)).rejects.toThrow(/banco caiu/);
    spy.mockRestore();
    expect(storage.list()).toEqual([]);
    expect((await row(productId)).path).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("falha depois do upload"), expect.anything());

    // Erro que não é "vendor fora do ar" (bug) propaga do mesmo jeito, sem órfão.
    transcriber.transcribe = async () => {
      throw new TypeError("boom");
    };
    await expect(record(productId)).rejects.toBeInstanceOf(TypeError);
    expect(storage.list()).toEqual([]);
    expect((await row(productId)).path).toBeNull();
  });

  it("o carimbo do texto só muda quando o texto muda: gravar sem transcrever e remover áudio não mexem nele", async () => {
    const productId = await product();
    transcriber.enqueueText("Linho puro");
    await record(productId);
    const stamped = (await row(productId)).updatedAt!.getTime();

    transcriber.failNext("fora do ar", "unavailable");
    await record(productId);
    expect((await row(productId)).updatedAt!.getTime()).toBe(stamped);
    expect((await row(productId)).note).toBe("Linho puro");

    await removeCuratorAudio(sdb, storage, { productId, userId: FIXED_USER_ID });
    expect((await row(productId)).updatedAt!.getTime()).toBe(stamped);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await updateCuratorNote(sdb, { productId, userId: FIXED_USER_ID, note: "Linho puro, caimento leve" });
    expect((await row(productId)).updatedAt!.getTime()).toBeGreaterThan(stamped);
  });

  it("o audit guarda o mime cru do navegador ao lado do canônico", async () => {
    const productId = await product();
    transcriber.enqueueText("nota");
    await record(productId, { ...AUDIO, originalContentType: "" });
    const [audit] = await audits(productId);
    expect(audit.after).toMatchObject({ mime: "audio/webm", originalMime: "" });
  });

  it("recusa formato que não é áudio, arquivo grande e gravação longa — sem subir nada", async () => {
    const productId = await product();
    await expect(record(productId, { data: Buffer.from("x"), contentType: "video/mp4" })).rejects.toThrow(
      /formato de áudio/,
    );
    await expect(
      record(productId, { data: Buffer.alloc(4 * 1024 * 1024), contentType: "audio/webm" }),
    ).rejects.toThrow(/grande demais/);
    await expect(record(productId, { ...AUDIO, seconds: 90 })).rejects.toThrow(/60 segundos/);
    // Sem duração informada (arquivo escolhido do aparelho), o tamanho é o limite.
    transcriber.enqueueText("ok");
    await expect(record(productId, { data: Buffer.alloc(2_900_000), contentType: "audio/mp4" })).resolves.toMatchObject({
      transcribed: true,
    });

    expect(storage.list()).toHaveLength(1);
  });

  it("peça inexistente é recusada com a classe de erro que a tela reconhece", async () => {
    const error = await record("00000000-0000-4000-8000-000000000abc").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("nao_encontrado");
    expect(storage.list()).toEqual([]);
  });
});

describe("updateCuratorNote / removeCuratorAudio", () => {
  it("a dona corrige o texto sem mexer no áudio; vazio tira a nota; acima do teto é recusado", async () => {
    const productId = await product();
    transcriber.enqueueText("texto da transcrição");
    const recorded = await record(productId, { ...AUDIO, seconds: 20 });
    const before = await row(productId);

    const fixed = await updateCuratorNote(sdb, {
      productId,
      userId: FIXED_USER_ID,
      note: "  Texto   corrigido pela dona. ",
    });
    expect(fixed.note).toBe("Texto corrigido pela dona.");
    const after = await row(productId);
    expect(after.note).toBe("Texto corrigido pela dona.");
    expect([after.path, after.mime, after.seconds]).toEqual([recorded.audioPath, "audio/webm", 20]);
    expect(after.updatedAt!.getTime()).toBeGreaterThanOrEqual(before.updatedAt!.getTime());
    const [audit] = await audits(productId);
    expect(audit).toMatchObject({
      action: "product.curator_note_updated",
      before: { note: "texto da transcrição" },
      after: { note: "Texto corrigido pela dona." },
    });

    await expect(
      updateCuratorNote(sdb, { productId, userId: FIXED_USER_ID, note: "x ".repeat(CURATOR_NOTE_MAX_CHARS) }),
    ).rejects.toMatchObject({ code: "nota_longa" });
    // Só símbolos não é nota nem é "apagar": recusa dizendo o quê.
    await expect(updateCuratorNote(sdb, { productId, userId: FIXED_USER_ID, note: "… !!" })).rejects.toMatchObject({
      code: "nota_sem_texto",
    });
    expect((await row(productId)).note).toBe("Texto corrigido pela dona.");

    await updateCuratorNote(sdb, { productId, userId: FIXED_USER_ID, note: "   " });
    expect((await row(productId)).note).toBeNull();
  });

  it("remover o áudio mantém o texto; sem áudio, não faz nada; remove que falha só avisa", async () => {
    const productId = await product();
    transcriber.enqueueText("a nota falada");
    const recorded = await record(productId, { ...AUDIO, seconds: 20 });

    expect(await removeCuratorAudio(sdb, storage, { productId, userId: FIXED_USER_ID })).toEqual({
      removed: true,
    });
    const saved = await row(productId);
    expect([saved.path, saved.mime, saved.seconds]).toEqual([null, null, null]);
    expect(saved.note).toBe("a nota falada");
    expect(storage.has(recorded.audioPath)).toBe(false);
    expect((await audits(productId))[0].action).toBe("product.curator_audio_removed");

    expect(await removeCuratorAudio(sdb, storage, { productId, userId: FIXED_USER_ID })).toEqual({
      removed: false,
    });

    transcriber.enqueueText("de novo");
    const again = await record(productId);
    storage.remove = async () => {
      throw new Error("storage indisponível");
    };
    expect(await removeCuratorAudio(sdb, storage, { productId, userId: FIXED_USER_ID })).toEqual({ removed: true });
    expect((await row(productId)).path).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(again.audioPath), expect.anything());
  });
});
