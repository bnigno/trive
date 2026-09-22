// Os settings do ensaio "foto no corpo", num módulo leve de propósito: as
// páginas do painel e a vitrine só precisam ler quatro interruptores — sem
// arrastar o gerador, o assistente e o sharp que services/studio.ts carrega.
import { HOUSE_MODEL_KEYS, SCENE_KEYS, type StudioQuality } from "@/core/studio/presets";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";

export type StudioSettings = {
  enabled: boolean;
  dailyQuota: number;
  quality: StudioQuality;
  defaultScene: (typeof SCENE_KEYS)[number];
  defaultModel: (typeof HOUSE_MODEL_KEYS)[number];
  inStore: boolean;
};

export const STUDIO_SETTING_KEYS = [
  "ai_photos_enabled",
  "ai_photos_daily_quota",
  "ai_photos_quality",
  "ai_photos_default_scene",
  "ai_photos_default_model",
  "ai_photos_in_store",
] as const;

export async function loadStudioSettings(db: DbOrTx): Promise<StudioSettings> {
  const map = await getSettingsMap(db, [...STUDIO_SETTING_KEYS]);
  const quality = map["ai_photos_quality"];
  const scene = map["ai_photos_default_scene"];
  const model = map["ai_photos_default_model"];
  return {
    enabled: map["ai_photos_enabled"] === true,
    dailyQuota: typeof map["ai_photos_daily_quota"] === "number" ? map["ai_photos_daily_quota"] : 30,
    quality: quality === "alta" ? "alta" : "economica",
    defaultScene: SCENE_KEYS.find((key) => key === scene) ?? "sala_clara",
    defaultModel: HOUSE_MODEL_KEYS.find((key) => key === model) ?? "modelo_a",
    inStore: map["ai_photos_in_store"] === true,
  };
}

export async function isAiPhotosEnabled(db: DbOrTx): Promise<boolean> {
  return (await loadStudioSettings(db)).enabled;
}

export async function isAiPhotosInStore(db: DbOrTx): Promise<boolean> {
  return (await loadStudioSettings(db)).inStore;
}
