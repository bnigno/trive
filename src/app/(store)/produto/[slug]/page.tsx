// Página de produto (PDP), "o camarim": galeria, seletor de variação, compra,
// fichas em <details> e peças relacionadas. Vitrine com ISR — revalida a cada
// 5 minutos; nunca force-dynamic.
import { buildProductJsonLd, serializeJsonLd } from "@/core/seo/json-ld";
import { siteUrl } from "@/lib/site-url";
import { parseCareNotes } from "@/core/catalog/care";
import { buildSizeChart, isSizeChartEmpty } from "@/core/catalog/measurements";
import { CuratorNote, hasCuratorNote } from "@/components/store/curator-note";
import { hasMuseumPlaque, MuseumPlaque } from "@/components/store/museum-plaque";
import { SizeChartTable } from "@/components/store/size-chart";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { IconChevron } from "@/components/store/icons";
import { ProductCard } from "@/components/store/product-card";
import { SectionHeading } from "@/components/store/section-heading";
import { fitSignalStoreLine, type FitSignal } from "@/core/catalog/fit-signal";
import { getFitSignalsForProduct } from "@/services/delivery-feedback";
import { getDb } from "@/db/client";
import {
  getPublicProductBySlug,
  listRelatedPublicProducts,
  publicFileUrl,
  publicImageUrl,
  publicMdUrl,
  publicThumbUrl,
} from "@/services/store-catalog";
import { loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";

import { ProductDetailClient } from "./product-detail-client";

export const revalidate = 300;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await getPublicProductBySlug(getDb(), slug);
  if (!product) return { title: "Produto não encontrado" };

  const description =
    product.description?.trim().slice(0, 160) ||
    `${product.name} — compre online.`;
  const canonical = `/produto/${product.slug}`;
  return {
    title: product.name,
    description,
    alternates: { canonical },
    openGraph: {
      title: product.name,
      description,
      type: "website",
      url: canonical,
      // O cartão editorial (nome e preço em ouro sobre noir) é a cara da peça
      // quando o link é colado no WhatsApp ou no Instagram; sem ele, a foto.
      images: product.postCardPath
        ? [{ url: publicImageUrl(product.postCardPath), alt: product.name, width: 1080, height: 1350 }]
        : product.images[0]
          ? [{ url: publicImageUrl(product.images[0].path), alt: product.name }]
          : undefined,
    },
  };
}

const crumb =
  "font-store text-eyebrow font-medium text-ink-500 uppercase transition-colors duration-300 ease-silk hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

/** Ficha dobrável (nativa, sem JS): título serif + chevron que gira ao abrir.
 *  "Details" no nome para não colidir com a folha de papel de order/sheet. */
function DetailsSheet({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className="group border-t border-ivory-300 py-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-display text-heading font-semibold text-espresso-900 [&::-webkit-details-marker]:hidden">
        {title}
        <IconChevron className="h-5 w-5 shrink-0 text-gold-700 transition-transform duration-300 ease-silk group-open:rotate-180" />
      </summary>
      <div className="pt-3 font-store text-[15px] leading-7 text-ink-700">
        {children}
      </div>
    </details>
  );
}

export default async function ProdutoPage({ params }: Props) {
  const { slug } = await params;
  const db = getDb();
  const product = await getPublicProductBySlug(db, slug);
  const fitSignals = product ? (await getFitSignalsForProduct(db, product.id)).filter((row) => row.signal !== null) : [];
  if (!product) notFound();

  // Ficha da peça (placa de museu) e fita métrica, quando a maison cadastrou.
  const plaque = {
    composition: product.composition,
    careNotes: product.careNotes,
    fitNotes: product.fitNotes,
  };
  const sizeChart = buildSizeChart(product.variants, product.attributesSchema);
  // "Falar com a Lia": o telefone da loja e o nome da vendedora (ISR de 5 min).
  const bridge = await loadBridgeSettings(db);
  const lia = { sellerName: bridge.sellerName, fallbackUrl: plainBridgeUrl(bridge) };
  // A nota da curadora: o texto e, se ela gravou, o áudio na voz dela.
  const curatorNote = {
    note: product.curatorNote,
    audioUrl: product.curatorAudioPath ? publicFileUrl(product.curatorAudioPath) : null,
    audioMime: product.curatorAudioMime,
  };

  const related = await listRelatedPublicProducts(db, {
    productId: product.id,
    categorySlug: product.categorySlug,
    limit: 4,
  });

  // Todas as fotos vão para o cliente com a cor a que pertencem; quem decide o
  // que aparece é a cor escolhida no seletor (core/catalog/product-images).
  const galleryImages = product.images.map((image) => ({
    full: publicImageUrl(image.path),
    md: publicMdUrl(image.path),
    thumb: publicThumbUrl(image.path),
    color: image.color,
  }));

  return (
    // pb-24 reserva o espaço da barra fixa de compra no celular.
    <div className="mx-auto max-w-6xl px-4 py-8 pb-24 sm:px-6 lg:pb-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            buildProductJsonLd(
              {
                name: product.name,
                slug: product.slug,
                description: product.description,
                composition: product.composition,
                brand: product.brand,
                imageUrls: product.images.map((image) => publicImageUrl(image.path)),
                variants: product.variants,
              },
              siteUrl(),
            ),
          ),
        }}
      />
      <nav aria-label="Navegação" className="mb-8 flex flex-wrap items-center gap-2">
        <Link href="/produtos" className={crumb}>
          Coleção
        </Link>
        {product.categoryName && product.categorySlug ? (
          <>
            <span aria-hidden="true" className="text-gold-500">
              ·
            </span>
            <Link
              href={`/produtos?categoria=${encodeURIComponent(product.categorySlug)}`}
              className={crumb}
            >
              {product.categoryName}
            </Link>
          </>
        ) : null}
      </nav>

      <ProductDetailClient
        productName={product.name}
        slug={product.slug}
        axes={product.attributesSchema}
        variants={product.variants}
        images={galleryImages}
        lia={lia}
        heading={
          <div>
            {product.brand ? (
              <p className="font-store text-eyebrow font-medium text-rose-700 uppercase">
                {product.brand}
              </p>
            ) : null}
            <h1 className="mt-2 font-display text-title font-semibold text-balance text-espresso-900">
              {product.name}
            </h1>
          </div>
        }
      >
        {hasCuratorNote(curatorNote) ? <CuratorNote data={curatorNote} /> : null}
        <div className="mt-4 border-b border-ivory-300">
          {product.description ? (
            <DetailsSheet title="Descrição" open>
              <p className="whitespace-pre-line">{product.description}</p>
            </DetailsSheet>
          ) : null}
          {hasMuseumPlaque(plaque) ? (
            <DetailsSheet title="Ficha da peça" open>
              <MuseumPlaque data={plaque} />
            </DetailsSheet>
          ) : null}
          {!isSizeChartEmpty(sizeChart) || fitSignals.length > 0 ? (
            <DetailsSheet title="Medidas (cm)">
              {!isSizeChartEmpty(sizeChart) ? <SizeChartTable chart={sizeChart} /> : null}
              {fitSignals.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1 font-store text-sm text-ink-700">
                  {fitSignals.map((row) => (
                    <li key={row.size}>{fitSignalStoreLine(row.size, row.signal as FitSignal)}</li>
                  ))}
                </ul>
              ) : null}
            </DetailsSheet>
          ) : null}
          <DetailsSheet title="Envio e trocas">
            <p>
              Enviamos para todo o Brasil. Primeira troca em até 7 dias corridos
              após o recebimento, conforme o Código de Defesa do Consumidor.
            </p>
          </DetailsSheet>
          {!parseCareNotes(plaque.careNotes).symbols.length &&
          !parseCareNotes(plaque.careNotes).freeText.length ? (
            <DetailsSheet title="Cuidados com a peça">
              <p>
                Lave à mão ou no ciclo delicado, com água fria. Seque à sombra e
                passe do avesso. Cada peça vem com instruções próprias na etiqueta.
              </p>
            </DetailsSheet>
          ) : null}
        </div>
      </ProductDetailClient>

      {related.items.length > 0 ? (
        <section aria-labelledby="relacionados" className="mt-16">
          <SectionHeading
            eyebrow={related.scope === "category" ? "Na mesma sala" : "Novidades"}
            title={related.scope === "category" ? "Também na maison" : "Mais da maison"}
            id="relacionados"
          />
          <div className="grid grid-cols-2 gap-x-3 gap-y-10 sm:gap-x-5 lg:grid-cols-4">
            {related.items.map((item) => (
              <ProductCard key={item.id} product={item} size="sm" />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
