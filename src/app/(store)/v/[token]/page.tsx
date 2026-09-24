// "Me ajuda a escolher?" — a página que a cliente manda às amigas: as 2 ou 3
// peças em dúvida, um toque para votar (sem cadastro) e, depois do voto, o
// convite para falar com a vendedora. Link aleatório: não se acha a votação
// de outra pessoa; fechada, a página mostra o resultado.
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Monogram } from "@/components/store/brand/monogram";
import { VoteBoard } from "@/components/store/friends/vote-board";
import { eyebrow } from "@/components/store/styles";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { getDb } from "@/db/client";
import { getPublicRound } from "@/services/friend-rounds";
import { getSettingsMap, getStoreName } from "@/services/settings";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const round = await getPublicRound(getDb(), token);
  if (!round) return { title: "Votação", robots: { index: false } };
  const firstPhoto = round.options.find((option) => option.imageUrl)?.imageUrl;
  const title = `Qual fica melhor na ${round.displayName}?`;
  return {
    title,
    description: `Vote com um toque: ${round.options.map((option) => `${option.letter}. ${option.name}`).join(" · ")}`,
    robots: { index: false, follow: false },
    openGraph: { title, ...(firstPhoto ? { images: [{ url: firstPhoto }] } : {}) },
  };
}

export default async function FriendsVotePage({ params }: Props) {
  const { token } = await params;
  const db = getDb();
  const round = await getPublicRound(db, token);
  if (!round) notFound();
  const [storeName, settings] = await Promise.all([getStoreName(db), getSettingsMap(db, ["bot_seller_name"])]);
  const sellerName = (typeof settings["bot_seller_name"] === "string" && settings["bot_seller_name"].trim()) || DEFAULT_SELLER_NAME;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col items-center gap-3 text-center">
        <Monogram size={40} tone="gold" priority />
        <p className={eyebrow}>Me ajuda a escolher?</p>
        <h1 className="font-display text-3xl font-normal leading-tight text-ink-950 sm:text-4xl">Qual fica melhor na {round.displayName}?</h1>
        <p className="max-w-md font-store text-sm text-ink-600">
          {round.open
            ? `Toque na sua escolha. É anônimo e rapidinho — a ${round.displayName} recebe o placar pelo WhatsApp da ${storeName}.`
            : "A votação já acabou. Olha como ficou:"}
        </p>
      </header>
      <VoteBoard
        token={round.token}
        displayName={round.displayName}
        sellerName={sellerName}
        open={round.open}
        options={round.options}
        initialCounts={round.tally.counts}
        initialTotal={round.tally.total}
      />
      <p className="text-center font-store text-xs text-ink-500">
        Guardamos só o voto e o recado (sem o seu telefone), e apagamos tudo 30 dias depois do fim da votação.
      </p>
    </main>
  );
}
