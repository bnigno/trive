// "Sua cartela": o espelho de estilo da maison em um minuto — seis passos
// com as cores e tamanhos reais da coleção, o nome poético da cartela e três
// peças escolhidas para ela. Guardar é opcional e pede consentimento.
import type { Metadata } from "next";

import { SectionHeading } from "@/components/store/section-heading";
import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { getStoreMap } from "@/services/store-catalog";

import { StyleQuiz } from "./style-quiz";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Sua cartela",
  description: "Em um minuto, a maison descobre a sua cartela de estilo e escolhe peças para você.",
  alternates: { canonical: "/estilo" },
  openGraph: { title: "Sua cartela", description: "Em um minuto, a maison descobre a sua cartela de estilo e escolhe peças para você.", url: "/estilo", type: "website" },
};

export default async function EstiloPage() {
  const map = await tryOrBuildFallback(
    { totalProducts: 0, categories: [], colors: [], sizes: [], editions: [] },
    () => getStoreMap(getDb()),
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <SectionHeading
        eyebrow="Espelho de estilo"
        title="Sua cartela em um minuto"
        id="cartela"
        align="left"
      />
      <p className="-mt-4 mb-8 max-w-2xl font-store text-base leading-relaxed text-ink-700">
        Sete perguntas, nenhuma resposta errada — a última é opcional. No fim, a maison dá um nome à sua cartela
        e separa três peças da coleção que conversam com ela.
      </p>
      <StyleQuiz colors={map.colors} sizes={map.sizes} />
    </div>
  );
}
