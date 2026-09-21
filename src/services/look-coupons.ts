// O mimo pela foto do "Quem já vestiu": as configurações da dona. A regra de
// elegibilidade é pura (core/looks/coupon); a emissão acontece no executor
// registrar_foto_com_a_peca, na mesma transação do turno.
import type { DbOrTx } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";

export interface LookCouponSettings {
  enabled: boolean;
  percent: number;
  days: number;
}

export const LOOK_COUPON_DEFAULTS: LookCouponSettings = { enabled: false, percent: 10, days: 60 };

export async function loadLookCouponSettings(db: DbOrTx): Promise<LookCouponSettings> {
  const map = await getSettingsMap(db, ["look_coupon_enabled", "look_coupon_percent", "look_coupon_days"]);
  const num = (key: string, fallback: number) => (typeof map[key] === "number" ? (map[key] as number) : fallback);
  return {
    enabled: map["look_coupon_enabled"] === true,
    percent: num("look_coupon_percent", LOOK_COUPON_DEFAULTS.percent),
    days: num("look_coupon_days", LOOK_COUPON_DEFAULTS.days),
  };
}
