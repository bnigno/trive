import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { getRunForCourier } from "@/services/delivery-runs";

import { CourierRun } from "./run-client";

export const dynamic = "force-dynamic";

// A prévia do link (WhatsApp) é só o título: nada da saída entra no HTML
// de metadados. O conteúdo em si é público a quem tem o token — o link é
// mandado só ao motoboy e morre quando a saída fecha.
export const metadata: Metadata = {
  title: "Saída do motoboy",
  description: "Página da saída — abra pelo link recebido no WhatsApp.",
  robots: { index: false, follow: false },
  openGraph: { title: "Saída do motoboy", description: "Abra pelo link recebido no WhatsApp." },
};

// A página do motoboy: o link que ele recebe no WhatsApp. O token é a
// credencial (uuid). Tudo que interage fica no client component; aqui só a
// leitura da saída.
export default async function EntregaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getRunForCourier(getDb(), token);
  if (!view) notFound();
  return <CourierRun token={token} view={serialize(view)} />;
}

/** Datas viram ISO para atravessar a fronteira RSC → client. */
function serialize(view: NonNullable<Awaited<ReturnType<typeof getRunForCourier>>>) {
  return {
    ...view,
    startedAt: view.startedAt?.toISOString() ?? null,
    stops: view.stops.map((stop) => ({ ...stop, deliveredAt: stop.deliveredAt?.toISOString() ?? null })),
  };
}

export type CourierRunProps = ReturnType<typeof serialize>;
