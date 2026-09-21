// Entrega por motoboy com janelas ("9h–12h", "16h–19h", "19h–21h") e
// hora-limite: pago antes do limite, chega HOJE na janela; depois, amanhã.
// Tudo no relógio de parede de São Paulo (nunca getHours() da Vercel) e com
// `now` injetado. Puro: expande as faixas cotadas em opções escolhíveis.
import { z } from "zod";

import { isSpDayKey, spDayKey, spMinutesOfDay, spNextDayKey } from "@/lib/sp-day";

export const SHIPPING_KINDS = ["correios", "motoboy"] as const;
export type ShippingKind = (typeof SHIPPING_KINDS)[number];

export const DELIVERY_WINDOWS_MAX = 4;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "19:00" → 1140. */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "19:00" → "19h"; "19:30" → "19h30". */
export function hourLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

export const deliveryWindowSchema = z
  .object({
    /** Início da janela, "HH:MM". */
    start: z.string().regex(HH_MM, "Horário no formato HH:MM."),
    /** Fim da janela, "HH:MM" (maior que o início). */
    end: z.string().regex(HH_MM, "Horário no formato HH:MM."),
    /** Até que horas o pagamento entra para a janela de hoje ("HH:MM", ≤ início). */
    cutoff: z.string().regex(HH_MM, "Horário no formato HH:MM."),
  })
  .refine((w) => minutesOf(w.start) < minutesOf(w.end), { message: "A janela precisa terminar depois de começar." })
  .refine((w) => minutesOf(w.cutoff) <= minutesOf(w.start), { message: "A hora-limite tem de ser antes de a janela começar." });
export type DeliveryWindow = z.infer<typeof deliveryWindowSchema>;

export const deliveryWindowsSchema = z.array(deliveryWindowSchema).max(DELIVERY_WINDOWS_MAX, `No máximo ${DELIVERY_WINDOWS_MAX} janelas.`);

/** O que a cotação do frete entrega para uma faixa (1 linha por faixa). */
export interface RateForOptions {
  rateId: string;
  name: string;
  priceCents: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
  kind: ShippingKind;
  deliveryWindows: DeliveryWindow[];
}

/** A janela escolhida, como vai no pedido (imutável depois). */
export interface DeliveryWindowChoice {
  /** 'YYYY-MM-DD' do dia da entrega em São Paulo. */
  dayKey: string;
  start: string;
  end: string;
  cutoff: string;
}

export type DeliveryOption =
  | {
      kind: "correios";
      optionKey: string;
      rateId: string;
      name: string;
      priceCents: number;
      deliveryDaysMin: number;
      deliveryDaysMax: number;
    }
  | {
      kind: "motoboy";
      optionKey: string;
      rateId: string;
      name: string;
      priceCents: number;
      window: DeliveryWindowChoice;
      /** "hoje" ou "amanhã" em relação a `now`. */
      when: "today" | "tomorrow";
      /** "hoje, 19h–21h · pague até 13h" / "amanhã, 19h–21h". */
      label: string;
    };

/** Chave estável da opção: faixa (Correios) ou faixa + dia + janela (motoboy). */
export function optionKeyFor(rateId: string, window?: { dayKey: string; start: string }): string {
  return window ? `${rateId}:${window.dayKey}:${window.start}` : rateId;
}

export function formatWindowLabel(window: { start: string; end: string; cutoff: string }, when: "today" | "tomorrow"): string {
  const range = `${hourLabel(window.start)}–${hourLabel(window.end)}`;
  return when === "today" ? `hoje, ${range} · pague até ${hourLabel(window.cutoff)}` : `amanhã, ${range}`;
}

/**
 * Onde o motoboy chega, a entrega é SÓ por motoboy: com ao menos uma faixa
 * de motoboy cotada para o CEP, as de Correios somem (decisão da dona,
 * 2026-09-17 — Belém e região só por motoboy). Sem motoboy, ficam as de
 * Correios que houver.
 */
export function motoboyExclusive<T extends { kind: ShippingKind; deliveryWindows: readonly unknown[] }>(rates: readonly T[]): T[] {
  // Faixa de motoboy sem janela (gravada por fora do painel) não vira opção nenhuma — não pode engolir os Correios.
  const motoboy = rates.filter((rate) => rate.kind === "motoboy" && rate.deliveryWindows.length > 0);
  return motoboy.length > 0 ? motoboy : [...rates];
}

/** Alguma faixa de motoboy ativa cobre o CEP (só a faixa de CEP, sem olhar o peso). */
export function motoboyCoversCep(rates: readonly { kind: ShippingKind; isActive?: boolean; cepStart: string; cepEnd: string }[], cep: string): boolean {
  const digits = cep.replace(/\D/g, "");
  return rates.some((rate) => rate.kind === "motoboy" && rate.isActive !== false && rate.cepStart <= digits && digits <= rate.cepEnd);
}

/**
 * A área do motoboy, para a cliente ler: os nomes das faixas de motoboy
 * ativas sem o prefixo "Motoboy", na ordem do CEP inicial (a capital, CEP
 * menor, vem primeiro: "Belém, Ananindeua e Castanhal"). Vazio quando não há
 * faixa.
 */
export function motoboyAreaLabel(rates: readonly { name: string; kind: ShippingKind; isActive?: boolean; cepStart?: string }[]): string {
  // A mesma cidade escrita em caixa diferente ("Belém" e "BELÉM") é uma só: fica a primeira grafia.
  const cities = [...rates]
    .filter((rate) => rate.kind === "motoboy" && rate.isActive !== false)
    .sort((a, b) => (a.cepStart ?? "").localeCompare(b.cepStart ?? ""))
    .map((rate) => rate.name.replace(/^\s*motoboy\s*[-–—:·]?\s*/i, "").trim())
    .filter((city, index, all) => city.length > 0 && all.findIndex((other) => other.toLocaleLowerCase("pt-BR") === city.toLocaleLowerCase("pt-BR")) === index);
  if (cities.length <= 1) return cities[0] ?? "";
  return `${cities.slice(0, -1).join(", ")} e ${cities[cities.length - 1]}`;
}

/**
 * Expande as faixas em opções: Correios vira uma; motoboy vira uma por
 * janela — hoje, se ainda dá tempo de pagar até a hora-limite (relógio de
 * SP), senão amanhã. Ordem: motoboy de hoje primeiro, depois o resto pelo
 * preço. Onde há motoboy, só motoboy (motoboyExclusive).
 */
export function expandDeliveryOptions(rates: readonly RateForOptions[], now: Date): DeliveryOption[] {
  const today = spDayKey(now);
  const tomorrow = spNextDayKey(today);
  const minutesNow = spMinutesOfDay(now);
  const options: DeliveryOption[] = [];
  for (const rate of motoboyExclusive(rates)) {
    if (rate.kind === "motoboy") {
      for (const window of rate.deliveryWindows) {
        const when: "today" | "tomorrow" = minutesNow < minutesOf(window.cutoff) ? "today" : "tomorrow";
        const choice = { dayKey: when === "today" ? today : tomorrow, start: window.start, end: window.end, cutoff: window.cutoff };
        options.push({
          kind: "motoboy",
          optionKey: optionKeyFor(rate.rateId, choice),
          rateId: rate.rateId,
          name: rate.name,
          priceCents: rate.priceCents,
          window: choice,
          when,
          label: formatWindowLabel(window, when),
        });
      }
      continue;
    }
    options.push({
      kind: "correios",
      optionKey: optionKeyFor(rate.rateId),
      rateId: rate.rateId,
      name: rate.name,
      priceCents: rate.priceCents,
      deliveryDaysMin: rate.deliveryDaysMin,
      deliveryDaysMax: rate.deliveryDaysMax,
    });
  }
  return options.sort((a, b) => {
    const aToday = a.kind === "motoboy" && a.when === "today" ? 0 : 1;
    const bToday = b.kind === "motoboy" && b.when === "today" ? 0 : 1;
    return aToday - bToday || a.priceCents - b.priceCents;
  });
}

/**
 * A janela escolhida ainda vale em `now`? Só os dias que a sacola oferece:
 * hoje (até a hora-limite) ou amanhã. Ontem, depois de amanhã ou um dia que
 * não existe ("2026-99-99") nunca — o payload vem do navegador.
 */
export function isWindowBookable(choice: DeliveryWindowChoice, now: Date): boolean {
  if (!isSpDayKey(choice.dayKey)) return false;
  const today = spDayKey(now);
  if (choice.dayKey === today) return spMinutesOfDay(now) < minutesOf(choice.cutoff);
  return choice.dayKey === spNextDayKey(today);
}

/** A janela escolhida existe na faixa? (comparação por horários) */
export function windowBelongsToRate(choice: { start: string; end: string; cutoff: string }, windows: readonly DeliveryWindow[]): boolean {
  return windows.some((w) => w.start === choice.start && w.end === choice.end && w.cutoff === choice.cutoff);
}

/** "hoje, 19h–21h" / "amanhã, 19h–21h" / "sábado, 19h–21h" (para o pedido e o painel). */
export function describeWindow(choice: DeliveryWindowChoice, now: Date): string {
  const today = spDayKey(now);
  const range = `${hourLabel(choice.start)}–${hourLabel(choice.end)}`;
  if (choice.dayKey === today) return `hoje, ${range}`;
  if (choice.dayKey === spNextDayKey(today)) return `amanhã, ${range}`;
  const [y, m, d] = choice.dayKey.split("-");
  return `${Number(d)}/${m}/${y}, ${range}`;
}

const WEEKDAYS_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"] as const;

/** Rótulo datado para o retrato do pedido: "sábado 20/09, 19h–21h" (não envelhece). */
export function windowDateLabel(choice: DeliveryWindowChoice): string {
  const [y, m, d] = choice.dayKey.split("-").map(Number);
  const weekday = WEEKDAYS_PT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}, ${hourLabel(choice.start)}–${hourLabel(choice.end)}`;
}

/** O que a página da peça promete a quem já digitou o CEP na sacola. */
export type SameDayPromise =
  | { kind: "today"; rateName: string; payUntil: string; windowLabel: string; label: string }
  | { kind: "tomorrow"; rateName: string; windowLabel: string; label: string };

/**
 * A promessa mais generosa entre as opções de motoboy: hoje, a janela com a
 * hora-limite mais tarde ("Pague até 17h e chega hoje, 19h–21h"); senão a
 * primeira de amanhã. Sem motoboy para o CEP → null (Correios não promete).
 */
export function sameDayPromise(options: readonly DeliveryOption[]): SameDayPromise | null {
  const motoboy = options.filter((o): o is Extract<DeliveryOption, { kind: "motoboy" }> => o.kind === "motoboy");
  const today = motoboy
    .filter((o) => o.when === "today")
    .sort((a, b) => minutesOf(b.window.cutoff) - minutesOf(a.window.cutoff) || minutesOf(a.window.start) - minutesOf(b.window.start));
  if (today[0]) {
    const o = today[0];
    const windowLabel = `${hourLabel(o.window.start)}–${hourLabel(o.window.end)}`;
    const payUntil = hourLabel(o.window.cutoff);
    return { kind: "today", rateName: o.name, payUntil, windowLabel, label: `Pague até ${payUntil} e chega hoje, ${windowLabel}` };
  }
  const tomorrow = motoboy.find((o) => o.when === "tomorrow");
  if (tomorrow) {
    const windowLabel = `${hourLabel(tomorrow.window.start)}–${hourLabel(tomorrow.window.end)}`;
    return { kind: "tomorrow", rateName: tomorrow.name, windowLabel, label: `Chega amanhã, ${windowLabel}` };
  }
  return null;
}
