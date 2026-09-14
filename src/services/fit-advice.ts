// "Vai me servir?": as medidas da cartela contra a tabela da peça, na hora.
// Leitura pura de duas fontes de verdade (perfil + variações) e o veredito
// do core; nada é gravado e nenhum número do corpo sai daqui além do
// veredito (folga em cm por tamanho).
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { buildSizeChart, parseMeasurements } from "@/core/catalog/measurements";
import { adviseSize, renderSizeAdvice, type SizeAdvice } from "@/core/style/fit";
import { products, productVariants } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";
import { getBodyMeasurements, getStyleProfileByPhone, getStyleProfileByToken } from "@/services/style-profiles";

export type FitAdviceView = { advice: SizeAdvice; text: string; hasChart: boolean };

export async function adviseSizeForProduct(
  db: DbOrTx,
  input: { slug: string; siteToken?: string; phoneE164?: string },
): Promise<FitAdviceView> {
  const slug = z.string().min(1).parse(input.slug);
  const [product] = await db
    .select({ id: products.id, attributesSchema: products.attributesSchema })
    .from(products)
    .where(and(eq(products.slug, slug), isNull(products.deletedAt)))
    .limit(1);
  if (!product) return { advice: { kind: "no_chart" }, text: renderSizeAdvice({ kind: "no_chart" }), hasChart: false };
  const variants = await db
    .select({ attributes: productVariants.attributes, measurements: productVariants.measurements })
    .from(productVariants)
    .where(and(eq(productVariants.productId, product.id), isNull(productVariants.deletedAt)));
  const chart = buildSizeChart(
    variants.map((variant) => ({ attributes: (variant.attributes ?? {}) as Record<string, string>, measurements: parseMeasurements(variant.measurements) })),
    (product.attributesSchema ?? []) as string[],
  );
  const profile = input.siteToken ? await getStyleProfileByToken(db, input.siteToken) : input.phoneE164 ? await getStyleProfileByPhone(db, input.phoneE164) : null;
  const body = await getBodyMeasurements(db, input);
  const advice = adviseSize(body?.body ?? null, chart, profile?.profile.fit ?? null);
  return { advice, text: renderSizeAdvice(advice), hasChart: chart.length > 0 };
}
