// "Me ajuda a escolher?" — a página que a cliente manda às amigas: as 2 ou 3
// peças em dúvida, um toque para votar (sem cadastro) e, depois do voto, o
// recado opcional e o convite para falar com a vendedora. Link aleatório:
// não se acha a votação de outra pessoa; fechada, mostra o resultado; 30 dias
// depois do fim, some.
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Monogram } from "@/components/store/brand/monogram";
import { VoteBoard } from "@/components/store/friends/vote-board";
import { eyebrow } from "@/components/store/styles";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { getDb } from "@/db/client";
import { getPublicRound } from "@/services/friend-rounds";
import { getSettingsMap, getStoreName } from "@/services/settings";
import { loadBridgeSettings, plainBridgeUrl } from "@/services/site-carts";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const db = getDb();
  const [round, storeName] = await Promise.all([getPublicRound(db, token), getStoreName(db)]);
  if (!round) return { title: "Votação", robots: { index: false, follow: false } };
  const firstPhoto = round.options.find((option) => option.imageUrl)?.imageUrl;
  const title = `Qual fica melhor na ${round.displayName}?`;
  return {
    title,
    description: `Vote com um toque: ${round.options.map((option) => `${option.letter}. ${option.name}`).join(" · ")}`,
    robots: { index: false, follow: false },
    openGraph: { title: `${title} · ${storeName}`, siteName: storeName, ...(firstPhoto ? { images: [{ url: firstPhoto, width: 800, height: 1000 }] } : {}) },
  };
}

export default async function FriendsVotePage({ params }: Props) {
  const { token } = await params;
  const db = getDb();
  const round = await getPublicRound(db, token);
  if (!round) notFound();
  const [storeName, settings, bridge] = await Promise.all([getStoreName(db), getSettingsMap(db, ["bot_seller_name"]), loadBridgeSettings(db)]);
  const sellerName = (typeof settings["bot_seller_name"] === "string" && settings["bot_seller_name"].trim()) || DEFAULT_SELLER_NAME;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <Monogram size={40} tone="gold" priority />
        <p className={eyebrow}>Me ajuda a escolher?</p>
        <h1 className="font-display text-3xl font-normal leading-tight text-ink-950 sm:text-4xl">Qual fica melhor na {round.displayName}?</h1>
        <p className="max-w-md font-store text-sm text-ink-700">
          {round.open
            ? `Toque na foto da sua escolha. A ${round.displayName} recebe o placar pelo WhatsApp da ${storeName}.`
            : "A votação já acabou. Olha como ficou:"}
        </p>
      </header>
      <noscript>
        <p className="text-center font-store text-sm text-ink-700">Para votar, abra este link no navegador do celular com o JavaScript ligado.</p>
      </noscript>
      <VoteBoard
        token={round.token}
        displayName={round.displayName}
        sellerName={sellerName}
        open={round.open}
        closesLabel={round.closesLabel}
        options={round.options}
        initialCounts={round.tally.counts}
        initialTotal={round.tally.total}
        fallbackUrl={plainBridgeUrl(bridge)}
      />
      <p className="mx-auto max-w-md text-center font-store text-xs text-ink-700">
        Seu voto não leva o seu telefone. Se deixar recado e nome, eles vão para a {round.displayName} pelo WhatsApp da {storeName}, junto com a letra que você escolheu. Votos e recados guardados aqui são apagados 30 dias depois do fim da votação.
      </p>
    </div>
  );
}
