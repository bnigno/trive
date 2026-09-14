// O lote do Ateliê: as fotos perto do recado, ainda não usadas, no máximo
// três — e o recado que cada tipo de mensagem carrega.
import { describe, expect, it } from "vitest";

import {
  INTAKE_LATE_PHOTO_MS,
  INTAKE_MAX_PHOTOS,
  INTAKE_NUDGE_AFTER_MS,
  INTAKE_WINDOW_MS,
  hasOpenBatch,
  isBatchStart,
  noteFromMessage,
  nudgeDue,
  openPhotos,
  selectIntakeBatch,
  selectLatePhotos,
  type IntakeMessage,
} from "@/core/atelier/batch";
import { INBOUND_MEDIA_MARKERS } from "@/core/whatsapp/media";

const T0 = new Date("2026-09-13T18:00:00Z");
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

function photo(id: string, seconds: number, extra: Partial<IntakeMessage> = {}): IntakeMessage {
  return {
    id,
    kind: "image",
    body: INBOUND_MEDIA_MARKERS.image,
    mediaUrl: `https://cdn/${id}.jpg`,
    createdAt: at(seconds),
    consumed: false,
    ...extra,
  };
}

function text(id: string, seconds: number, body: string): IntakeMessage {
  return { id, kind: "text", body, mediaUrl: null, createdAt: at(seconds), consumed: false };
}

describe("hasOpenBatch / openPhotos", () => {
  it("foto recente sem recado = lote aberto; foto de 16 minutos atrás, não", () => {
    expect(hasOpenBatch([photo("f1", -5 * 60)], T0)).toBe(true);
    expect(hasOpenBatch([photo("f1", -16 * 60)], T0)).toBe(false);
    expect(INTAKE_WINDOW_MS).toBe(15 * 60_000);
  });

  it("foto já usada por outra chegada, foto sem URL e recado não abrem lote", () => {
    expect(hasOpenBatch([photo("f1", -60, { consumed: true })], T0)).toBe(false);
    expect(hasOpenBatch([photo("f1", -60, { mediaUrl: null })], T0)).toBe(false);
    expect(hasOpenBatch([text("t1", -60, "chegou o vestido")], T0)).toBe(false);
    expect(hasOpenBatch([], T0)).toBe(false);
  });

  it("openPhotos devolve em ordem de chegada", () => {
    const list = openPhotos([photo("f2", -30), photo("f1", -90)], T0);
    expect(list.map((item) => item.id)).toEqual(["f1", "f2"]);
  });
});

describe("isBatchStart / nudgeDue", () => {
  it("só a primeira foto sem dona abre o lote; a segunda não", () => {
    expect(isBatchStart([photo("f1", -5)], "f1", T0)).toBe(true);
    expect(isBatchStart([photo("f1", -60), photo("f2", -5)], "f2", T0)).toBe(false);
    // Foto anterior já reivindicada: a nova abre um lote novo.
    expect(isBatchStart([photo("f1", -60, { consumed: true }), photo("f2", -5)], "f2", T0)).toBe(true);
    expect(INTAKE_NUDGE_AFTER_MS).toBe(180_000);
  });

  it("o lembrete vale se a foto continua sem recado; reivindicada ou fora da janela, não", () => {
    expect(nudgeDue([photo("f1", -180), photo("f2", -100)], "f1", T0)).toEqual({ due: true, photos: 2 });
    expect(nudgeDue([photo("f1", -180, { consumed: true })], "f1", T0)).toEqual({ due: false, photos: 0 });
    expect(nudgeDue([photo("f1", -20 * 60)], "f1", T0)).toEqual({ due: false, photos: 0 });
  });
});

describe("selectIntakeBatch", () => {
  it("três fotos e o recado: as fotos em ordem e o recado como texto", () => {
    const note = text("n1", 0, "chegou o Longo Dunas, 3 de cada");
    const batch = selectIntakeBatch([photo("f1", -120), photo("f2", -90), photo("f3", -60), note], note);
    expect(batch.photos.map((item) => item.id)).toEqual(["f1", "f2", "f3"]);
    expect(batch.note).toBe("chegou o Longo Dunas, 3 de cada");
    expect(batch.noteKind).toBe("text");
  });

  it("passando do máximo, ficam as mais recentes antes do recado (em ordem)", () => {
    const note = text("n1", 0, "vestido");
    const messages = [photo("f1", -300), photo("f2", -240), photo("f3", -180), photo("f4", -120), photo("f5", -60), note];
    const batch = selectIntakeBatch(messages, note);
    expect(batch.photos).toHaveLength(INTAKE_MAX_PHOTOS);
    expect(batch.photos.map((item) => item.id)).toEqual(["f3", "f4", "f5"]);
  });

  it("ao abrir, só as fotos ANTES do recado são reivindicadas; a atrasada fica para a montagem", () => {
    const note = text("n1", 0, "saia midi");
    const batch = selectIntakeBatch([photo("f1", -10), note, photo("f2", 20)], note);
    expect(batch.photos.map((item) => item.id)).toEqual(["f1"]);
  });

  it("foto usada por outra chegada e foto fora da janela ficam de fora", () => {
    const note = text("n1", 0, "saia midi");
    const batch = selectIntakeBatch(
      [photo("old", -20 * 60), photo("used", -30, { consumed: true }), photo("f1", -10), note],
      note,
    );
    expect(batch.photos.map((item) => item.id)).toEqual(["f1"]);
  });

  it("recado na legenda: a própria foto entra no lote e a legenda vira o recado", () => {
    const captioned = photo("f2", 0, { body: `${INBOUND_MEDIA_MARKERS.image} Cropped canelado, custou 40` });
    const batch = selectIntakeBatch([photo("f1", -15), captioned], captioned);
    expect(batch.photos.map((item) => item.id)).toEqual(["f1", "f2"]);
    expect(batch.note).toBe("Cropped canelado, custou 40");
    expect(batch.noteKind).toBe("caption");
  });
});

describe("noteFromMessage", () => {
  it("áudio ainda com o marcador não tem recado; transcrito, o texto é o recado", () => {
    expect(noteFromMessage({ kind: "audio", body: INBOUND_MEDIA_MARKERS.audio })).toEqual({ note: "", noteKind: "audio" });
    expect(noteFromMessage({ kind: "audio", body: "chegou o longo dunas" })).toEqual({
      note: "chegou o longo dunas",
      noteKind: "audio",
    });
  });

  it("foto sem legenda não tem recado; com legenda, a legenda sem o marcador", () => {
    expect(noteFromMessage({ kind: "image", body: INBOUND_MEDIA_MARKERS.image })).toEqual({ note: "", noteKind: "caption" });
    expect(noteFromMessage({ kind: "image", body: `${INBOUND_MEDIA_MARKERS.image}  Baby look ` })).toEqual({
      note: "Baby look",
      noteKind: "caption",
    });
  });
});

describe("selectLatePhotos", () => {
  it("absorve fotos sem dona que chegaram até 60 s depois do recado, até completar o máximo", () => {
    const note = text("n1", 0, "saia midi");
    const messages = [note, photo("f2", 20), photo("f3", 40), photo("used", 50, { consumed: true }), photo("f4", 55), photo("late", 120)];
    expect(selectLatePhotos(messages, note, 1).map((item) => item.id)).toEqual(["f2", "f3"]);
    expect(selectLatePhotos(messages, note, 0).map((item) => item.id)).toEqual(["f2", "f3", "f4"]);
    expect(selectLatePhotos(messages, note, INTAKE_MAX_PHOTOS)).toEqual([]);
    expect(INTAKE_LATE_PHOTO_MS).toBe(60_000);
  });

  it("recado como legenda: a própria foto não é 'atrasada'", () => {
    const captioned = photo("f1", 0, { body: `${INBOUND_MEDIA_MARKERS.image} Cropped` });
    expect(selectLatePhotos([captioned, photo("f2", 10)], captioned, 1).map((item) => item.id)).toEqual(["f2"]);
  });
});
