import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/db/client";
import { getRunForCourier } from "@/services/delivery-runs";

import { CourierRun } from "./run-client";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Saída do motoboy",
  robots: { index: false, follow: false },
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
