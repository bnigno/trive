// Página-cortina do link de story (/ig/dunas): a foto da peça sobre noir por
// um instante e a cliente cai no WhatsApp da Lia com a mensagem pronta. O
// preview do link (og:image) é o cartão da peça — é o que aparece no sticker.
// Link desligado leva à página da peça (ou à home); slug desconhecido é 404.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Monogram } from "@/components/store/brand/monogram";
import { Wordmark } from "@/components/store/brand/wordmark";
import { eyebrowNoir } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { getCampaignCurtain } from "@/services/campaign-links";
import { getSettingsMap } from "@/services/settings";
import { publicMdUrl } from "@/services/store-catalog";

import { curtainMetadata } from "./curtain-metadata";
import { CurtainRedirect } from "./curtain-redirect";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

async function loadStoreName(): Promise<string> {
  const map = await getSettingsMap(getDb(), ["store_name"]);
  return (typeof map.store_name === "string" && map.store_name.trim()) || STORE_NAME_DEFAULT;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const [curtain, storeName] = await Promise.all([getCampaignCurtain(getDb(), slug), loadStoreName()]);
  return curtainMetadata(curtain, storeName);
}

export default async function CampaignCurtainPage({ params }: Props) {
  const { slug } = await params;
  const [curtain, storeName] = await Promise.all([getCampaignCurtain(getDb(), slug), loadStoreName()]);
  if (!curtain) notFound();
  if (!curtain.isActive) redirect(curtain.productSlug ? `/produto/${curtain.productSlug}` : "/");

  const product = curtain.product;
  const photo = product?.images[0]?.path ?? null;

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-6 py-12 text-center">
      {photo ? (
        <img
          src={publicMdUrl(photo)}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40 blur-[2px]"
          fetchPriority="high"
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-noir-950/40 via-noir-950/70 to-noir-950" aria-hidden="true" />

      <div className="relative flex w-full max-w-sm flex-col items-center gap-8">
        <div className="flex items-center gap-2.5">
          <Monogram size={28} tone="gold" priority />
          <Wordmark className="text-base text-ivory-100">{storeName}</Wordmark>
        </div>

        {product ? (
          <div className="flex flex-col items-center gap-3">
            {photo ? (
              <img
                src={publicMdUrl(photo)}
                alt={product.name}
                width={220}
                height={275}
                className="h-[275px] w-[220px] rounded-(--radius-hair) object-cover shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]"
                fetchPriority="high"
              />
            ) : null}
            <p className={eyebrowNoir}>Do story</p>
            <h1 className="font-display text-3xl font-normal leading-tight text-ivory-50">{product.name}</h1>
          </div>
        ) : (
          <h1 className="font-display text-3xl font-normal leading-tight text-ivory-50">{curtain.label}</h1>
        )}

        <p className="text-sm text-ivory-200/80" aria-live="polite">
          Abrindo o WhatsApp da {curtain.sellerName}…
        </p>

        <CurtainRedirect slug={curtain.slug} sellerName={curtain.sellerName} fallbackUrl={curtain.plainWaUrl} />

        {product ? (
          <Link
            href={`/produto/${product.slug}`}
            className="min-h-11 text-xs uppercase tracking-[0.16em] text-gold-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200"
          >
            Ver a peça no site
          </Link>
        ) : (
          <Link
            href="/"
            className="min-h-11 text-xs uppercase tracking-[0.16em] text-gold-300 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200"
          >
            Entrar na maison
          </Link>
        )}
      </div>
    </main>
  );
}
