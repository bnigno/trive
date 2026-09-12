// A peça do lançamento vista pela convidada, antes da publicação — a mesma
// ficha da vitrine (galeria, variações, sacola), com o token provando o
// convite. Publicada, manda para a página normal da peça.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { eyebrowTaupe } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { formatDropMoment, getDropForToken } from "@/services/drops";
import { CuratorNote, hasCuratorNote } from "@/components/store/curator-note";
import { getPublicProductBySlug, publicFileUrl, publicImageUrl, publicMdUrl, publicThumbUrl } from "@/services/store-catalog";

import { ProductDetailClient } from "../../../produto/[slug]/product-detail-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function LancamentoPecaPage({ params }: { params: Promise<{ token: string; slug: string }> }) {
  const { token, slug } = await params;
  const db = getDb();
  const view = await getDropForToken(db, token);
  if (!view) notFound();
  if (view.drop.phase === "published") redirect(`/produto/${slug}`);
  if (view.drop.phase !== "vip" && view.drop.phase !== "scheduled") notFound();
  if (!view.products.some((product) => product.slug === slug)) notFound();

  const product = await getPublicProductBySlug(db, slug, { inviteToken: token });
  if (!product) notFound();
  // A nota da curadora também na janela VIP: a Lia diz que ela está "na página da peça".
  const curatorNote = {
    note: product.curatorNote,
    audioUrl: product.curatorAudioPath ? publicFileUrl(product.curatorAudioPath) : null,
    audioMime: product.curatorAudioMime,
  };

  const galleryImages = product.images.map((image) => ({
    full: publicImageUrl(image.path),
    md: publicMdUrl(image.path),
    thumb: publicThumbUrl(image.path),
    color: image.color,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-2 font-store text-eyebrow uppercase text-ink-500">
        <Link href={`/lancamento/${token}`} className="hover:text-gold-800">
          {view.drop.name}
        </Link>
        <span aria-hidden="true">·</span>
        <span className="text-gold-800">Você vê primeiro até {formatDropMoment(view.drop.publishAt)}</span>
      </nav>
      <ProductDetailClient
        productName={product.name}
        slug={product.slug}
        axes={product.attributesSchema}
        variants={product.variants}
        images={galleryImages}
        heading={
          <div>
            {product.brand ? <p className={eyebrowTaupe}>{product.brand}</p> : null}
            <h1 className="mt-2 font-display text-title font-semibold text-balance text-espresso-900">{product.name}</h1>
          </div>
        }
      >
        {hasCuratorNote(curatorNote) ? <CuratorNote data={curatorNote} /> : null}
        <div className="mt-4 border-b border-ivory-300 pb-4 font-store text-[15px] leading-7 text-ink-700">
          {product.description ? <p className="whitespace-pre-line">{product.description}</p> : null}
        </div>
      </ProductDetailClient>
    </div>
  );
}
