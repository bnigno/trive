// /estreia — a próxima estreia da maison: contagem regressiva, as peças atrás
// do véu (silhuetas desfocadas) e "me avisa quando a cortina abrir". Na hora
// marcada a página abre pelo relógio (ISR de 60 s + refresh da contagem):
// as peças aparecem com foto e preço. Sem estreia marcada, um convite calmo.
import type { Metadata } from "next";
import Link from "next/link";

import { getFileStorage } from "@/adapters/storage";
import { Monogram } from "@/components/store/brand/monogram";
import { Countdown } from "@/components/store/estreia/countdown";
import { WaitlistForm } from "@/components/store/estreia/waitlist-form";
import { NoirStage } from "@/components/store/noir-stage";
import { ProductCard } from "@/components/store/product-card";
import { SectionHeading } from "@/components/store/section-heading";
import { btnGold, btnOutlineNoir, eyebrowNoir } from "@/components/store/styles";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { publicDropLabel } from "@/core/drops";
import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { buildSilhouettes } from "@/services/drop-teaser";
import { getUpcomingDropTeaser, type DropTeaser } from "@/services/drops";
import { getSettingsMap } from "@/services/settings";
import { listPublicProducts } from "@/services/store-catalog";

// ISR curto: na hora marcada a página vira sozinha (o relógio decide a fase)
// e a contagem insiste em recarregar até ver a cortina aberta.
export const revalidate = 30;

export const metadata: Metadata = {
  title: "Estreia",
  description: "A próxima estreia da TRIVÉ: a data, a contagem e as peças atrás do véu. Peça para ser avisada quando a cortina abrir.",
  alternates: { canonical: "/estreia" },
};

async function loadTeaser(): Promise<{ teaser: DropTeaser | null; sellerName: string }> {
  // getDb() dentro do fallback: no build do CI não há DATABASE_URL.
  const [teaser, settings] = await Promise.all([
    tryOrBuildFallback(null, () => getUpcomingDropTeaser(getDb())),
    tryOrBuildFallback({}, () => getSettingsMap(getDb(), ["bot_seller_name"])),
  ]);
  const sellerName = (typeof settings.bot_seller_name === "string" && settings.bot_seller_name.trim()) || DEFAULT_SELLER_NAME;
  return { teaser, sellerName };
}

export default async function EstreiaPage() {
  const { teaser, sellerName } = await loadTeaser();
  const now = new Date();

  if (!teaser) {
    return (
      <NoirStage grain className="flex min-h-[70svh] flex-col items-center justify-center px-6 py-16 text-center text-ivory-100">
        <Monogram size={56} tone="gold" priority />
        <p className={`${eyebrowNoir} mt-8`}>Estreia</p>
        <h1 className="mt-3 font-display text-3xl font-normal text-ivory-50 sm:text-4xl">A próxima cortina ainda não tem data.</h1>
        <p className="mt-4 max-w-md font-store text-sm text-ivory-200/80">
          Quando a TRIVÉ marcar a estreia, a contagem começa aqui. Enquanto isso, a coleção está aberta.
        </p>
        <Link href="/produtos" className={`${btnGold} mt-8 w-full max-w-xs`}>
          Ver a coleção
        </Link>
      </NoirStage>
    );
  }

  if (teaser.state === "open") {
    const products = await tryOrBuildFallback([], () =>
      listPublicProducts(getDb(), { productIds: teaser.products.map((p) => p.id), limit: teaser.products.length || 1 }),
    );
    return (
      <div className="flex flex-col">
        <NoirStage grain className="flex flex-col items-center px-6 py-14 text-center text-ivory-100">
          <p className={eyebrowNoir}>A cortina abriu</p>
          <h1 className="mt-3 font-display text-4xl font-normal text-ivory-50 sm:text-5xl">{teaser.name}</h1>
          {teaser.edition?.openingLine ? (
            <p className="mt-3 font-display text-xl text-ivory-200/90 italic">{teaser.edition.openingLine}</p>
          ) : null}
          <p className="mt-4 max-w-md font-store text-sm text-ivory-200/80">
            As peças estão na TRIVÉ. Se quiser, a {sellerName} guarda uma por 24 horas — é só chamar.
          </p>
          <Link href="/produtos" className={`${btnGold} mt-8 w-full max-w-xs`}>
            Ver a coleção
          </Link>
        </NoirStage>
        <section aria-labelledby="pecas" className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
          <SectionHeading eyebrow={teaser.name} title="As peças da estreia" id="pecas" />
          {products.length === 0 ? (
            <p className="font-store text-sm text-ink-500">As peças estão sendo preparadas — volte em instantes.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 lg:gap-6">
              {products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  const silhouettes = await buildSilhouettes(
    getFileStorage(),
    teaser.products.map((p) => p.imagePath),
  );
  const veiled = teaser.products.map((p, index) => ({ ...p, silhouette: silhouettes[index] })).filter((p) => p.silhouette);

  return (
    <NoirStage grain className="flex flex-col items-center px-4 py-14 text-center text-ivory-100 sm:px-6">
      <div className="flex w-full max-w-3xl flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <Monogram size={44} tone="gold" priority />
          <p className={eyebrowNoir}>Estreia · {publicDropLabel(teaser.publishAt, now)}</p>
          <h1 className="font-display text-4xl font-normal leading-tight text-ivory-50 sm:text-5xl">{teaser.name}</h1>
          {teaser.edition?.openingLine ? (
            <p className="font-display text-xl text-ivory-200/90 italic">{teaser.edition.openingLine}</p>
          ) : null}
        </div>

        <Countdown publishAtIso={teaser.publishAt.toISOString()} serverNowIso={now.toISOString()} />

        {veiled.length > 0 ? (
          <ul aria-label="Peças atrás do véu" className="grid w-full grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3">
            {veiled.slice(0, 8).map((piece) => (
              <li key={piece.id} className="relative aspect-[4/5] overflow-hidden rounded-(--radius-hair) bg-noir-900">
                <img src={piece.silhouette as string} alt="" aria-hidden="true" className="h-full w-full object-cover opacity-80" />
                <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-noir-950/70 to-transparent" aria-hidden="true" />
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex w-full max-w-xl flex-col items-center gap-4">
          <p className="font-store text-sm text-ivory-200/85">
            {teaser.products.length > 0
              ? `${teaser.products.length} ${teaser.products.length === 1 ? "peça" : "peças"} atrás do véu. Deixe o seu WhatsApp e a ${sellerName} te avisa na hora — uma mensagem só.`
              : `Deixe o seu WhatsApp e a ${sellerName} te avisa na hora — uma mensagem só.`}
          </p>
          <WaitlistForm dropId={teaser.dropId} sellerName={sellerName} />
          {teaser.waitlist.total > 0 ? (
            <p className="font-store text-xs text-ivory-200/60">
              {teaser.waitlist.total === 1 ? "1 pessoa já pediu para ser avisada." : `${teaser.waitlist.total} pessoas já pediram para ser avisadas.`}
            </p>
          ) : null}
        </div>

        <Link href="/produtos" className={`${btnOutlineNoir} mt-2`}>
          Enquanto isso, a coleção
        </Link>
      </div>
    </NoirStage>
  );
}
