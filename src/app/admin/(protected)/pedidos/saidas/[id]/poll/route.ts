// GET /admin/pedidos/saidas/<id>/poll — o mapa ao vivo do painel. Só com
// sessão (401 em JSON, sem redirect: quem chama é fetch).
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/db/client";
import { getAuthUserOrNull } from "@/services/auth";
import { getDeliveryRun } from "@/services/delivery-runs";

import { serializeRunLive } from "./schema";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getAuthUserOrNull();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const run = await getDeliveryRun(getDb(), id);
  if (!run) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  return NextResponse.json(serializeRunLive(run), { headers: NO_STORE });
}
