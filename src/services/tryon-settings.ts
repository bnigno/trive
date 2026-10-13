// Os settings do "Me vê com ela", num módulo leve de propósito: o painel e a
// Lia só precisam ler três números — sem arrastar o gerador e o sharp que a
// fila (services/tryon-generate.ts) carrega.
import { TRYON_DEFAULTS } from "@/core/tryon/rules";
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";

export type TryOnSettings = { enabled: boolean; perCustomerDaily: number; dailyTotal: number };

export const TRYON_SETTING_KEYS = ["tryon_enabled", "tryon_per_customer_daily", "tryon_daily_total"] as const;

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

export async function loadTryOnSettings(db: DbOrTx): Promise<TryOnSettings> {
  const map = await getSettingsMap(db, [...TRYON_SETTING_KEYS]);
  return {
    enabled: map["tryon_enabled"] === true,
    perCustomerDaily: positiveInt(map["tryon_per_customer_daily"], TRYON_DEFAULTS.perCustomerDaily),
    dailyTotal: positiveInt(map["tryon_daily_total"], TRYON_DEFAULTS.dailyTotal),
  };
}

export async function isTryOnEnabled(db: DbOrTx): Promise<boolean> {
  return (await loadTryOnSettings(db)).enabled;
}
