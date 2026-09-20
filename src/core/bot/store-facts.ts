// "Ficha da loja": os fatos fixos da casa que entram no prompt de sistema —
// onde fica, como entrega, como paga, como troca. PURO: quem junta settings,
// faixas de frete e Mercado Pago é src/services/store-facts.ts. O texto só
// muda quando a dona muda um dado, então o prefixo cacheado do prompt segue
// estável. Valores exatos (frete, prazo, estoque) NUNCA entram aqui — são das
// ferramentas.
import { hourLabel, minutesOf, type DeliveryWindow } from "@/core/shipping/delivery-windows";
import { EXCHANGE_FACTS } from "@/core/store/exchange-facts";

export type StoreFactsInput = {
  storeName: string;
  /** A frase da loja (setting store_tagline ou o padrão do hero). */
  heroLine: string;
  /** Texto "sobre a loja" (setting store_about); vazio = sem linha. */
  about: string;
  address: string;
  instagram: string;
  siteUrl: string;
  /** Horário de atendimento (setting store_hours); vazio = sem linha. */
  hours: string;
  /** Retirada (setting store_pickup); vazio = sem linha. */
  pickup: string;
  /** Faixas de motoboy ativas: área (cidades) e janelas; null = não há motoboy. */
  motoboy: { area: string; windows: readonly DeliveryWindow[] } | null;
  /** Correios: cotado na hora (SuperFrete ligado com CEP de origem) ou calculado pela equipe. */
  correios: "cotado_na_hora" | "pela_equipe";
  payment: { onlineLink: boolean; manualPix: boolean };
  /** Política de troca em texto (setting store_exchange_policy); vazia = não cadastrada. */
  exchangePolicy: string;
};

const EXCHANGE_POLICY_MISSING = "ainda não cadastrada — diga que a equipe explica direitinho e transfira se ela precisar";

function windowLabel(window: DeliveryWindow): string {
  return `${hourLabel(window.start)}–${hourLabel(window.end)} (pague até ${hourLabel(window.cutoff)})`;
}

/** Janelas sem repetição, na ordem do dia — as faixas de motoboy costumam repetir as mesmas. */
function uniqueWindows(windows: readonly DeliveryWindow[]): DeliveryWindow[] {
  const seen = new Set<string>();
  const unique: DeliveryWindow[] = [];
  for (const window of windows) {
    const key = `${window.start}|${window.end}|${window.cutoff}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(window);
  }
  return unique.sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
}

/** O bloco em pt-BR, uma linha por fato; linha só quando o fato existe. Determinístico. */
export function renderStoreFacts(input: StoreFactsInput): string {
  const lines: string[] = [];
  const clean = (value: string) => value.trim();

  lines.push(`• ${clean(input.storeName)} — moda feminina brasileira. "${clean(input.heroLine)}"`);
  if (clean(input.about) !== "") lines.push(`• Sobre: ${clean(input.about)}`);

  const contact = [
    clean(input.address) !== "" ? `Endereço: ${clean(input.address)}` : null,
    clean(input.instagram) !== "" ? `Instagram: ${clean(input.instagram)}` : null,
    `Site: ${clean(input.siteUrl)}`,
  ].filter((part): part is string => part !== null);
  lines.push(`• ${contact.join(" · ")}`);

  if (clean(input.hours) !== "") lines.push(`• Atendimento: ${clean(input.hours)}`);
  if (clean(input.pickup) !== "") lines.push(`• Retirada: ${clean(input.pickup)}`);

  const correios =
    input.correios === "cotado_na_hora"
      ? "Correios (PAC ou SEDEX) cotados na hora por cotar_frete; prazo em dias úteis a partir da postagem."
      : "Correios com o frete calculado pela equipe — cotar_frete diz quando é o caso; não há valor nem prazo para prometer.";
  if (input.motoboy && clean(input.motoboy.area) !== "") {
    const windows = uniqueWindows(input.motoboy.windows);
    const janelas = windows.length > 0 ? `, nas janelas ${windows.map(windowLabel).join(" · ")}` : "";
    lines.push(
      `• Entrega por motoboy em ${clean(input.motoboy.area)}${janelas}. Pagou antes da hora-limite, sai na janela do dia; depois, na do dia seguinte. Onde o motoboy chega não há Correios. Valor e janela do dia: só cotar_frete.`,
    );
    lines.push(`• Fora dessa área: ${correios}`);
  } else {
    lines.push(`• Entrega: ${correios}`);
  }

  const payment: string[] = [];
  if (input.payment.onlineLink) {
    payment.push("link de pagamento (Pix ou cartão) que criar_pedido devolve");
    if (input.payment.manualPix) payment.push("Pix manual pela equipe só se o link falhar (enviar_chave_pix)");
  } else if (input.payment.manualPix) {
    payment.push("Pix pela chave da loja (enviar_chave_pix) — o link de pagamento online está desligado");
  } else {
    payment.push("combinado com a equipe (o link de pagamento online está desligado)");
  }
  payment.push("dinheiro na entrega só se a cliente pedir");
  lines.push(`• Pagamento: ${payment.join(". ").replace(/^./, (c) => c.toUpperCase())}.`);

  lines.push(
    `• Troca e devolução: arrependimento em até ${EXCHANGE_FACTS.regretDays} dias corridos após receber (frete de volta por conta da loja, reembolso integral em até ${EXCHANGE_FACTS.refundBusinessDays} dias úteis); defeito em até ${EXCHANGE_FACTS.defectDaysDurable} dias (troca, devolução ou abatimento). Quem conduz é a equipe: acolha e transfira.`,
  );
  lines.push(`• Política de troca: ${clean(input.exchangePolicy) !== "" ? clean(input.exchangePolicy) : EXCHANGE_POLICY_MISSING}.`);
  return lines.join("\n");
}
