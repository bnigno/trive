// O handler do vídeo da peça (product.ai_video) com as dependências
// injetadas: o evento é roteado, o resultado vai para o log, e na ÚLTIMA
// tentativa da fila o vídeo não fica "na fila" para sempre — vira "falhou"
// com o motivo antes de a linha da fila morrer (e relança).
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StudioUnavailableError } from "@/adapters/image-studio";
import { FakeImageStudio } from "@/adapters/image-studio/fake";
import { FakeFileStorage } from "@/adapters/storage/fake";
import * as schema from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { outboxHandlers } from "@/queue/handlers";
import { runStudioVideo } from "@/queue/handlers/studio";
import { STUDIO_VIDEO_EVENT } from "@/services/studio-video";
import { createTestDb, type TestDb } from "../helpers/db";

vi.mock("@/inngest/client", () => ({ inngest: { send: async () => ({ ids: [] }) } }));

const NOW = new Date("2026-09-25T13:00:00Z");

let db: TestDb;
let close: () => Promise<void>;
let studio: FakeImageStudio;
let storage: FakeFileStorage;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  studio = new FakeImageStudio();
  storage = new FakeFileStorage();
  vi.spyOn(console, "info").mockImplementation(() => {});
  await db.insert(schema.settings).values([{ key: "ai_video_enabled", value: true }]);
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
});

async function seedQueuedVideo(): Promise<string> {
  const [product] = await db.insert(schema.products).values({ name: "P", slug: "p", status: "active", pieceType: "vestido" }).returning({ id: schema.products.id });
  const [request] = await db
    .insert(schema.studioRequests)
    .values({ productId: product!.id, sceneKey: "estudio", modelKey: "modelo_a", sizeKey: "M", quality: "alta", optionsWanted: 1 })
    .returning({ id: schema.studioRequests.id });
  const path = "studio/products/p/c.jpg";
  await storage.upload({ path, data: await sharp({ create: { width: 30, height: 40, channels: 3, background: "#7a2432" } }).jpeg().toBuffer(), contentType: "image/jpeg" });
  const [candidate] = await db.insert(schema.studioCandidates).values({ requestId: request!.id, optionNo: 1, storagePath: path, status: "chosen" }).returning({ id: schema.studioCandidates.id });
  const [video] = await db
    .insert(schema.studioVideos)
    .values({ productId: product!.id, candidateId: candidate!.id, sourceStoragePath: path, durationSeconds: 5, resolution: "1080p", prompt: "p", credits: 6 })
    .returning({ id: schema.studioVideos.id });
  return video!.id;
}

const event = (videoId: string, attempts: number) => ({ id: "evt-1", eventType: STUDIO_VIDEO_EVENT, payload: { videoId }, attempts });

describe("runStudioVideo", () => {
  it("o evento está registrado na fila", () => {
    expect(outboxHandlers[STUDIO_VIDEO_EVENT]).toBeTypeOf("function");
  });

  it("termina o vídeo e devolve o resultado", async () => {
    const videoId = await seedQueuedVideo();
    const result = await runStudioVideo({ db: db as unknown as DbOrTx, studio, storage, now: () => NOW }, event(videoId, 0));
    expect(result).toMatchObject({ outcome: "done" });
  });

  it("falha passageira antes da última tentativa: relança e o vídeo segue na fila", async () => {
    const videoId = await seedQueuedVideo();
    studio.failNext(new StudioUnavailableError("muitas chamadas", "rate_limited", 429));
    await expect(runStudioVideo({ db: db as unknown as DbOrTx, studio, storage, now: () => NOW }, event(videoId, 1))).rejects.toMatchObject({ reason: "rate_limited" });
    const [video] = await db.select().from(schema.studioVideos).where(eq(schema.studioVideos.id, videoId));
    expect(video!.status).toBe("queued");
  });

  it("última tentativa: marca 'falhou' (nada cobrado) e relança para a linha da fila morrer", async () => {
    const videoId = await seedQueuedVideo();
    studio.failNext(new StudioUnavailableError("muitas chamadas", "rate_limited", 429));
    await expect(runStudioVideo({ db: db as unknown as DbOrTx, studio, storage, now: () => NOW }, event(videoId, 3))).rejects.toMatchObject({ reason: "rate_limited" });
    const [video] = await db.select().from(schema.studioVideos).where(eq(schema.studioVideos.id, videoId));
    expect(video).toMatchObject({ status: "failed", usdCents: 0 });
    expect(video!.errorDetail).toMatch(/^sem_envio:/);
  });
});
