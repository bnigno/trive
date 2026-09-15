// GET /pedido/<token>/rastreio — a leitura da entrega para a página do
// pedido (o token público é a credencial, como na própria página). Sem
// endereço nem destino: só o que buildTrackingView devolve.
import { NextResponse } from "next/server";

import { serializeTrackingView } from "@/core/delivery/tracking-json";
import { getDb } from "@/db/client";
import { getTrackingForOrder } from "@/services/delivery-runs";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  const view = await getTrackingForOrder(getDb(), token);
  if (!view) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(serializeTrackingView(view), { headers: NO_STORE });
}
