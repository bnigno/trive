// Home "Noite de Estreia": véu noir, hero grudado (sticky) coberto pela
// "manhã" marfim ao rolar (a cortina), manifesto, coleção, salas, cuidados e
// o convite noir que emenda no rodapé. Vitrine com ISR — nunca force-dynamic
// aqui; o conteúdo revalida a cada 5 minutos.
import type { Viewport } from "next";
import Link from "next/link";
import { preload } from "react-dom";

import { BrandVeil } from "@/components/store/brand-veil";
import { Monogram, markSrcSet } from "@/components/store/brand/monogram";
import { Tagline } from "@/components/store/brand/tagline";
import { Wordmark } from "@/components/store/brand/wordmark";
import { HeroSentinel } from "@/components/store/hero-sentinel";
import {
  IconArrowRight,
  IconExchange,
  IconParcel,
  IconShield,
  IconWhatsApp,
} from "@/components/store/icons";
import { NoirStage } from "@/components/store/noir-stage";
import { ProductCard } from "@/components/store/product-card";
import { Reveal } from "@/components/store/reveal";
import { Ribbon } from "@/components/store/ribbon";
import { SectionHeading } from "@/components/store/section-heading";
import {
  btnGold,
  btnOutlineNoir,
  eyebrowTaupe,
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { getDb } from "@/db/client";
import { STORE_NAME_DEFAULT, VEIL_SEEN_KEY } from "@/lib/brand";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { waMeUrl } from "@/lib/phone";
import { getSettingsMap } from "@/services/settings";
import {
  listPublicCategories,
  listPublicProducts,
} from "@/services/store-catalog";

export const revalidate = 300;

// A barra do Safari fica noir na home inteira (parte do conceito).
export const viewport: Viewport = {
  themeColor: "#0B0A09",
  viewportFit: "cover",
};

const HERO_MARK_SIZES = "(min-width: 640px) 320px, 58vw";
// O preload cobre o srcset inteiro; este src é só o fallback (400w = 2× no iPhone).
const HERO_MARK_SRC = "/brand/mark-dark-400.webp";

// Roda antes do primeiro paint: quem já viu o véu nesta sessão não o vê rodar
// de novo (ler sessionStorage só na hidratação chegaria tarde em 4G).
const VEIL_SEEN_SCRIPT = `try{if(sessionStorage.getItem(${JSON.stringify(VEIL_SEEN_KEY)}))document.documentElement.setAttribute("data-veil-seen","")}catch(e){}`;

// Textos padrão; o dono pode trocá-los em /admin/configuracoes › Vitrine
// (settings store_tagline / store_manifesto, vazio = padrão).
const DEFAULT_TAGLINE = "Para a mulher que se veste de si.";
const DEFAULT_MANIFESTO = [
  "Vestir é um jeito de contar quem você é — sem precisar dizer uma palavra.",
  "A TRIVÉ nasce de um laço: entre o clássico e o agora, entre a mulher que você é de manhã e a que chega em casa à noite.",
];

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Manifesto do painel: um parágrafo por linha em branco. */
function manifestoParagraphs(raw: string): string[] {
  return raw
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const CARE = [
  {
    icon: IconParcel,
    title: "Envio para todo o Brasil",
    text: "Cada peça viaja embalada como presente.",
  },
  {
    icon: IconShield,
    title: "Pagamento seguro",
    text: "Pix com confirmação acompanhada de perto, sem surpresa.",
  },
  {
    icon: IconExchange,
    title: "Primeira troca sem drama",
    text: "Até 7 dias, como manda o Código de Defesa do Consumidor.",
  },
] as const;

const railHidden =
  "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export default async function HomePage() {
  // A marca escura do hero é a imagem LCP: abre a conexão e baixa cedo.
  preload(HERO_MARK_SRC, {
    as: "image",
    fetchPriority: "high",
    imageSrcSet: markSrcSet("gold"),
    imageSizes: HERO_MARK_SIZES,
  });

  const [products, categories, settings] = await tryOrBuildFallback(
    [[], [], {}],
    () => {
      const db = getDb();
      return Promise.all([
        listPublicProducts(db, { limit: 8 }),
        listPublicCategories(db),
        getSettingsMap(db, [
          "store_name",
          "store_whatsapp",
          "store_tagline",
          "store_manifesto",
        ]),
      ]);
    },
  );
  const storeName = asText(settings.store_name) || STORE_NAME_DEFAULT;
  const tagline = asText(settings.store_tagline) || DEFAULT_TAGLINE;
  const manifestoFromPanel = manifestoParagraphs(asText(settings.store_manifesto));
  const manifesto =
    manifestoFromPanel.length > 0 ? manifestoFromPanel : DEFAULT_MANIFESTO;
  const whatsappUrl = waMeUrl(
    settings.store_whatsapp,
    `Olá! Vim pelo site da ${storeName}`,
  );

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: VEIL_SEEN_SCRIPT }} />
      <BrandVeil />

      <div className="cinema">
        {/* 1. Estreia — hero noir grudado; o .day desliza por cima ao rolar. */}
        <section
          aria-label="Estreia"
          className="hero noir-stage grain flex flex-col text-ivory-100"
        >
          <Ribbon
            variant="drift"
            tone="noir"
            size="xl"
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-15"
          />
          <div
            className="hero-content relative mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center gap-6 px-4 py-10 text-center sm:px-6"
            style={{
              paddingLeft: "max(1rem, env(safe-area-inset-left))",
              paddingRight: "max(1rem, env(safe-area-inset-right))",
            }}
          >
            <Monogram
              tone="gold"
              size={320}
              priority
              sizes={HERO_MARK_SIZES}
              className="h-auto w-[min(58vw,38svh)] sm:w-[min(20rem,38svh)]"
            />
            <h1 className="mt-2">
              <Wordmark weight="normal" className="text-hero gold-sheen">
                {storeName}
              </Wordmark>
            </h1>
            <Tagline tone="noir" />
            <p className="max-w-md font-display text-xl text-ivory-200 italic sm:text-2xl">
              {tagline}
            </p>
            {products.length > 0 ? (
              <Link
                href="/produtos"
                className={cx(btnGold, "mt-2 w-full sm:w-auto sm:min-w-64")}
              >
                Ver a coleção
              </Link>
            ) : null}
          </div>
          <a
            href="#colecao"
            aria-label="Rolar para a coleção"
            className="relative mx-auto mb-4 flex h-11 w-11 items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200"
            style={{ marginBottom: "max(1rem, env(safe-area-inset-bottom))" }}
          >
            <span
              aria-hidden="true"
              className="block h-10 w-px animate-cue-pulse bg-gold-brush"
            />
          </a>
        </section>

        {/* O dia: marfim desliza por cima da noite. */}
        <div className="day">
          <HeroSentinel />
          {/* "A luz entra": fora de qualquer Reveal (o topo do dia nasce em
              innerHeight e o Reveal o trataria como já visível). */}
          <div
            aria-hidden="true"
            className="h-40 bg-linear-to-b from-noir-900 to-ivory-100"
          />

          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            {products.length === 0 ? (
              <section className="mb-16 flex flex-col items-center gap-4 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-6 py-20 text-center">
                <Ribbon variant="static" size="md" className="opacity-70" />
                <p className="font-display text-heading font-semibold text-espresso-900">
                  A maison está sendo preparada
                </p>
                <p className="max-w-md text-sm text-ink-500">
                  Estamos alinhando cada peça. Em breve, a coleção abre as
                  portas.
                </p>
              </section>
            ) : (
              <>
                {/* 2. Amanhecer — manifesto */}
                <section
                  aria-labelledby="manifesto"
                  className="relative overflow-hidden py-10 sm:py-16"
                >
                  <h2 id="manifesto" className="sr-only">
                    Manifesto
                  </h2>
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-display text-[28vw] leading-none font-semibold tracking-[0.2em] text-ivory-300/70 select-none"
                  >
                    {storeName}
                  </span>
                  <div className="relative flex flex-col items-center gap-8 text-center sm:items-start sm:text-left">
                    <Reveal>
                      <Ribbon variant="draw" size="md" />
                    </Reveal>
                    {manifesto.map((sentence, index) => (
                      <Reveal key={sentence} delay={index * 140}>
                        <p className="max-w-3xl font-display text-manifesto text-balance text-ink-800 italic">
                          {sentence}
                        </p>
                      </Reveal>
                    ))}
                    <Reveal delay={manifesto.length * 140}>
                      <p className={eyebrowTaupe}>
                        Uma maison brasileira, com a elegância de quem não
                        precisa provar nada.
                      </p>
                    </Reveal>
                  </div>
                </section>

                {/* 3. A Coleção */}
                <section aria-labelledby="colecao" className="py-12">
                  <SectionHeading
                    eyebrow="A coleção"
                    title="Novidades da maison"
                    id="colecao"
                    aside={
                      <Link
                        href="/produtos"
                        className="group inline-flex min-h-11 items-center gap-2 font-store text-sm tracking-[0.16em] text-ink-700 uppercase transition-colors duration-300 hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                      >
                        Ver tudo
                        <IconArrowRight className="h-4 w-4 transition-transform duration-300 ease-silk group-hover:translate-x-1" />
                      </Link>
                    }
                  />
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 lg:gap-6">
                    {products.map((product, index) => (
                      <Reveal
                        key={product.id}
                        delay={index * 60}
                        className="h-full *:h-full"
                      >
                        <ProductCard product={product} />
                      </Reveal>
                    ))}
                  </div>
                </section>

                {/* 4. As Salas */}
                {categories.length > 0 ? (
                  <section aria-labelledby="salas" className="pb-12">
                    <SectionHeading
                      eyebrow="Explore"
                      title="As salas da maison"
                      id="salas"
                    />
                    <div
                      className={cx(
                        "-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-5 sm:overflow-visible sm:px-0 lg:grid-cols-4",
                        railHidden,
                      )}
                    >
                      {categories.map((category, index) => (
                        <Reveal
                          key={category.id}
                          delay={index * 60}
                          className="w-[72vw] shrink-0 snap-center sm:w-auto"
                        >
                          <Link
                            href={`/produtos?categoria=${encodeURIComponent(category.slug)}`}
                            className="group relative flex aspect-[3/4] flex-col justify-end overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 p-5 transition-colors duration-300 hover:border-gold-500/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                          >
                            {/* Marca-d'água editorial: inicial da sala em serif gigante */}
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute -top-8 right-1 font-display text-[10rem] leading-none font-semibold text-ivory-400/50 transition-transform duration-700 ease-silk select-none group-hover:-translate-y-1"
                            >
                              {category.name.charAt(0)}
                            </span>
                            <Ribbon
                              variant="hover"
                              size="sm"
                              className="absolute bottom-16 left-5 h-3"
                            />
                            <span className="relative font-display text-heading font-semibold text-espresso-900">
                              {category.name}
                            </span>
                            <span className="relative mt-1 font-store text-eyebrow text-rose-700 uppercase tabular-nums">
                              {category.productCount}{" "}
                              {category.productCount === 1 ? "peça" : "peças"}
                            </span>
                            <span className="relative mt-3 inline-flex items-center gap-2 font-store text-xs tracking-[0.18em] text-ink-700 uppercase">
                              Entrar
                              <IconArrowRight className="h-4 w-4 transition-transform duration-300 ease-silk group-hover:translate-x-1" />
                            </span>
                          </Link>
                        </Reveal>
                      ))}
                    </div>
                  </section>
                ) : null}

                {/* 5. Cuidados da maison — quieta de propósito */}
                <Reveal className="pb-16">
                  <section
                    aria-label="Cuidados da maison"
                    className="grid divide-y divide-ivory-300 rounded-(--radius-hair) border border-ivory-300 bg-ivory-200 sm:grid-cols-3 sm:divide-x sm:divide-y-0"
                  >
                    {CARE.map((item, index) => (
                      <div
                        key={item.title}
                        className="flex flex-col items-center gap-3 px-6 py-8 text-center"
                      >
                        <span className="font-display text-sm font-semibold tracking-[0.3em] text-gold-800 tabular-nums">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <item.icon className="h-6 w-6 text-gold-800" />
                        <p className="font-store text-sm font-medium tracking-[0.14em] text-ink-900 uppercase">
                          {item.title}
                        </p>
                        <p className="max-w-xs text-sm text-ink-700">
                          {item.text}
                        </p>
                      </div>
                    ))}
                  </section>
                </Reveal>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 6. Noite — convite final, fora da cortina; emenda no rodapé noir. */}
      <NoirStage grain aria-label="Convite" className="py-20 sm:py-28">
        <Ribbon
          variant="drift"
          tone="noir"
          size="xl"
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-10"
        />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-7 px-4 text-center sm:px-6">
          <Monogram tone="gold" size={72} lazy />
          <p className="font-display text-3xl text-ivory-100 italic sm:text-4xl">
            Entre. A maison é sua.
          </p>
          <div className="flex w-full flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/produtos"
              className={cx(btnGold, "w-full sm:w-auto sm:min-w-64")}
            >
              Conhecer a coleção
            </Link>
            {whatsappUrl ? (
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cx(btnOutlineNoir, "w-full sm:w-auto")}
              >
                <IconWhatsApp className="h-5 w-5" />
                Falar com a maison
              </a>
            ) : null}
          </div>
        </div>
      </NoirStage>
    </>
  );
}
