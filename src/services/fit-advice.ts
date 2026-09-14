// "Vai me servir?": as medidas da cartela contra a tabela da peça, na hora.
// Leitura pura de duas fontes de verdade (perfil + variações) e o veredito
// do core; nada é gravado e nenhum número do corpo sai daqui além do
// veredito (folga em cm por tamanho).
import { z } from "zod";

import { buildSizeChart } from "@/core/catalog/measurements";
import { adviseSize, renderSizeAdvice, type SizeAdvice } from "@/core/style/fit";
import type { DbOrTx } from "@/queue/enqueue";
import { getPublicProductBySlug } from "@/services/store-catalog";
import { getBodyMeasurements, getStyleProfileByPhone, getStyleProfileByToken } from "@/services/style-profiles";

export type FitAdviceView = { advice: SizeAdvice; text: string; hasChart: boolean };

export async function adviseSizeForProduct(
  db: DbOrTx,
  input: { slug: string; siteToken?: string; phoneE164?: string; bodyToken?: string | null },
): Promise<FitAdviceView> {
  const slug = z.string().min(1).parse(input.slug);
  // A mesma tabela que a vitrine mostra (só peça ativa e variações à venda).
  const product = await getPublicProductBySlug(db, slug);
  if (!product) return { advice: { kind: "no_chart" }, text: renderSizeAdvice({ kind: "no_chart" }), hasChart: false };
  const chart = buildSizeChart(product.variants, product.attributesSchema);
  const profile = input.siteToken ? await getStyleProfileByToken(db, input.siteToken) : input.phoneE164 ? await getStyleProfileByPhone(db, input.phoneE164) : null;
  const body = await getBodyMeasurements(db, input);
  const advice = adviseSize(body?.body ?? null, chart, profile?.profile.fit ?? null);
  return { advice, text: renderSizeAdvice(advice), hasChart: chart.length > 0 };
}
