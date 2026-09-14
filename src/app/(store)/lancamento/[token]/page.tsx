// "Você vê primeiro": a convidada abre o lançamento antes de todo mundo.
// O token é dela; a visita conta no relatório. Depois da publicação a
// página manda para a coleção (as peças já estão na vitrine).
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ProductCard } from "@/components/store/product-card";
import { SectionHeading } from "@/components/store/section-heading";
import { btnGold, eyebrowTaupe } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { waMeUrl } from "@/lib/phone";
import { formatDropMoment, getDropForToken, recordDropVisit } from "@/services/drops";
import { getSettingsMap } from "@/services/settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Você vê primeiro", robots: { index: false, follow: false } };

export default async function LancamentoPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = getDb();
  const view = await getDropForToken(db, token);
  if (!view) notFound();
  if (view.drop.phase === "published") redirect("/produtos");
  if (view.drop.phase === "canceled" || view.drop.phase === "draft") notFound();
  await recordDropVisit(db, token);

  const settings = await getSettingsMap(db, ["store_whatsapp"]);
  const whatsapp = waMeUrl(
    settings["store_whatsapp"],
    `Oi! Recebi o convite do lançamento ${view.drop.name} e quero que a Lia separe uma peça por 24 h.`,
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <p className={eyebrowTaupe}>Convite da TRIVÉ</p>
      <h1 className="mt-2 font-display text-title font-semibold text-espresso-900">
        {view.invite.firstName ? `${view.invite.firstName}, você vê primeiro.` : "Você vê primeiro."}
      </h1>
      <p className="mt-3 max-w-2xl font-store text-base leading-relaxed text-ink-700">
        {view.drop.name} abre para todo mundo em {formatDropMoment(view.drop.publishAt)}. Até lá, estas peças
        só existem para quem foi convidada — e a Lia pode separar uma para você por 24 horas.
      </p>
      {whatsapp ? (
        <a href={whatsapp} className={`${btnGold} mt-6`} target="_blank" rel="noopener noreferrer">
          Pedir para a Lia separar por 24 h
        </a>
      ) : null}

      <section aria-labelledby="pecas" className="mt-12">
        <SectionHeading eyebrow={view.drop.name} title="As peças do lançamento" id="pecas" />
        {view.products.length === 0 ? (
          <p className="font-store text-sm text-ink-500">As peças estão sendo preparadas — volte em instantes.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 lg:gap-6">
            {view.products.map((product) => (
              <ProductCard key={product.id} product={product} href={`/lancamento/${token}/${product.slug}`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
