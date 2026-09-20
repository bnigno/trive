// Junta o que a "ficha da loja" precisa — settings, faixas de frete do
// motoboy, Correios automático e Mercado Pago — e entrega o bloco pronto
// (core/bot/store-facts.ts) para o prompt da Lia e para a prévia do painel.
import { renderStoreFacts, type StoreFactsInput } from "@/core/bot/store-facts";
import { motoboyAreaLabel, type DeliveryWindow } from "@/core/shipping/delivery-windows";
import { STORE_HERO_LINE_DEFAULT, STORE_INSTAGRAM_DEFAULT, STORE_NAME_DEFAULT } from "@/lib/brand";
import type { DbOrTx } from "@/queue/enqueue";
import { getCorreiosAutoSettings } from "@/services/correios-quotes";
import { getSettingsMap, type ServiceDb } from "@/services/settings";
import { listShippingRates } from "@/services/shipping";
import { isMpEnabled } from "@/services/store-payments";
import { siteBaseUrl } from "@/services/wa-messaging";

export const STORE_FACTS_SETTING_KEYS = [
  "store_name",
  "store_tagline",
  "store_about",
  "store_address",
  "store_instagram",
  "store_hours",
  "store_pickup",
  "store_pix_key",
  "store_exchange_policy",
] as const;

export async function getStoreFactsInput(db: DbOrTx, opts: { siteUrl: string }): Promise<StoreFactsInput> {
  const sdb = db as unknown as ServiceDb;
  const [map, rates, onlineLink, correios] = await Promise.all([
    getSettingsMap(sdb, [...STORE_FACTS_SETTING_KEYS]),
    listShippingRates(sdb),
    isMpEnabled(db),
    getCorreiosAutoSettings(sdb),
  ]);
  const text = (key: (typeof STORE_FACTS_SETTING_KEYS)[number]): string => (typeof map[key] === "string" ? (map[key] as string).trim() : "");

  const motoboyRates = rates.filter((rate) => rate.kind === "motoboy" && rate.isActive);
  const windows: DeliveryWindow[] = motoboyRates.flatMap((rate) => rate.deliveryWindows);
  const area = motoboyAreaLabel(motoboyRates);

  return {
    storeName: text("store_name") || STORE_NAME_DEFAULT,
    heroLine: text("store_tagline") || STORE_HERO_LINE_DEFAULT,
    about: text("store_about"),
    address: text("store_address"),
    instagram: text("store_instagram") || STORE_INSTAGRAM_DEFAULT,
    siteUrl: opts.siteUrl,
    hours: text("store_hours"),
    pickup: text("store_pickup"),
    motoboy: motoboyRates.length > 0 && area !== "" ? { area, windows } : null,
    correios: correios.enabled && correios.storeCep ? "cotado_na_hora" : "pela_equipe",
    payment: { onlineLink, manualPix: text("store_pix_key") !== "" },
    exchangePolicy: text("store_exchange_policy"),
  };
}

/** O bloco da ficha como a Lia o lê (prompt) e como o painel mostra na prévia. */
export async function getStoreFacts(db: DbOrTx): Promise<string> {
  return renderStoreFacts(await getStoreFactsInput(db, { siteUrl: siteBaseUrl() }));
}
