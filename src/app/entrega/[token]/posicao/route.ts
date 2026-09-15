// POST /entrega/<token>/posicao — uma amostra do GPS do motoboy. O token do
// link é a credencial; corpo JSON (fetch ou sendBeacon com Blob JSON). Só a
// saída na rua aceita; o resto responde 200 com accepted:false para o
// celular não ficar tentando.
import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import { recordRunPosition } from "@/services/delivery-runs";
import { ServiceError } from "@/services/orders";

import { positionBodySchema } from "./schema";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ accepted: false, reason: "invalid" }, { status: 400, headers: NO_STORE });
  }
  const parsed = positionBodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ accepted: false, reason: "invalid" }, { status: 400, headers: NO_STORE });
  try {
    const result = await recordRunPosition(getDb(), {
      courierToken: token,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      accuracyM: parsed.data.accuracyM ?? null,
      speedMps: parsed.data.speedMps ?? null,
      recordedAt: new Date(parsed.data.recordedAt),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "RUN_NOT_FOUND") {
      return NextResponse.json({ accepted: false, reason: "not_found" }, { status: 404, headers: NO_STORE });
    }
    console.error("[entrega/posicao] falha ao gravar posição", error);
    return NextResponse.json({ accepted: false, reason: "error" }, { status: 500, headers: NO_STORE });
  }
}
