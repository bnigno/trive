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
  /** Faixas de motoboy ativas: área (cidades) e as janelas de cada cidade; null = não há motoboy. `area` vazia = faixa sem nome de cidade. */
  motoboy: { area: string; cities: readonly { city: string; windows: readonly DeliveryWindow[] }[] } | null;
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
  // O texto da dona pode dizer que HÁ ou que NÃO HÁ retirada; o que vale para
  // as ferramentas é fixo: criar_pedido não tem retirada (cotar_frete só
  // devolve motoboy e Correios) — quem insistir em retirar, é com a equipe.
  if (clean(input.pickup) !== "") lines.push(`• Retirada: ${clean(input.pickup)}`);
  lines.push("• Pedido pelo sistema é sempre com entrega (motoboy ou Correios): criar_pedido não tem opção de retirada; se ela quiser retirar, monte a sacola e chame transferir_para_atendente.");

  const correios =
    input.correios === "cotado_na_hora"
      ? "Correios (PAC ou SEDEX) cotados na hora por cotar_frete; prazo em dias úteis a partir da postagem."
      : "Correios com o frete calculado pela equipe — cotar_frete diz quando é o caso; não há valor nem prazo para prometer.";
  if (input.motoboy) {
    const onde = clean(input.motoboy.area) !== "" ? `em ${clean(input.motoboy.area)}` : "na área atendida (cotar_frete diz se o CEP dela entra)";
    const perCity = input.motoboy.cities.map((c) => ({ city: c.city, windows: uniqueWindows(c.windows) })).filter((c) => c.windows.length > 0);
    const allSame = perCity.length > 0 && perCity.every((c) => c.windows.map(windowLabel).join("|") === perCity[0].windows.map(windowLabel).join("|"));
    const janelas =
      perCity.length === 0
        ? ""
        : allSame
          ? `, nas janelas ${perCity[0].windows.map(windowLabel).join(" · ")}`
          : ` — janelas por cidade: ${perCity.map((c) => `${c.city} ${c.windows.map(windowLabel).join(" · ")}`).join("; ")}`;
    lines.push(
      `• Entrega por motoboy ${onde}${janelas}. Pagou antes da hora-limite, sai na janela do dia; depois, na do dia seguinte. Onde o motoboy chega não há Correios. Valor e janela do dia: só cotar_frete.`,
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
  const policy = clean(input.exchangePolicy) !== "" ? clean(input.exchangePolicy).replace(/[.!?…]+$/u, "") : EXCHANGE_POLICY_MISSING;
  lines.push(`• Política de troca: ${policy}.`);
  return lines.join("\n");
}
