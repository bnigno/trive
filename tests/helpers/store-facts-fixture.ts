import type { StoreFactsInput } from "@/core/bot/store-facts";

/** Os dados reais da loja em 2026-09-20 (7 cidades do motoboy, 3 janelas). */
export const FICHA_REAL: StoreFactsInput = {
  storeName: "TRIVÉ",
  heroLine: "Para a mulher que se veste de si.",
  about: "Peças escolhidas com calma, em edições pequenas, para o calor de Belém.",
  address: "Belém — PA",
  instagram: "@trive_mfeminine",
  siteUrl: "https://www.trivemaison.com.br",
  hours: "segunda a sábado, 9h às 19h",
  pickup: "",
  motoboy: {
    area: "Belém, Ananindeua, Marituba, Castanhal, Santa Izabel, Benevides e Santa Bárbara",
    // Cada cidade com as suas janelas (iguais aqui: a ficha imprime uma lista só); repetidas entram uma vez.
    cities: [
      { city: "Belém", windows: [{ start: "19:00", end: "21:00", cutoff: "17:00" }, { start: "09:00", end: "12:00", cutoff: "08:00" }, { start: "16:00", end: "19:00", cutoff: "13:00" }, { start: "09:00", end: "12:00", cutoff: "08:00" }] },
      { city: "Ananindeua", windows: [{ start: "09:00", end: "12:00", cutoff: "08:00" }, { start: "16:00", end: "19:00", cutoff: "13:00" }, { start: "19:00", end: "21:00", cutoff: "17:00" }] },
    ],
  },
  correios: "cotado_na_hora",
  payment: { onlineLink: true, manualPix: true },
  exchangePolicy: "Troca ou devolução em até 7 dias após receber, peça sem uso e com etiqueta.",
};
