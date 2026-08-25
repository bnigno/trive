import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { processInboundMpWebhook } from "@/services/webhooks";

export const dynamic = "force-dynamic";

// Webhook do Mercado Pago. A assinatura (x-signature) É a autenticação —
// sem auth adicional. SEMPRE responde 200 rápido: em erro o MP reenvia por
// dias, e a verdade fica no nosso registro interno (inbound_events); o
// processamento real é assíncrono via outbox e reconsulta a API do MP.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const rawDataId =
      url.searchParams.get("data.id") ?? url.searchParams.get("id");

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // Corpo ausente ou não-JSON (formato IPN antigo manda tudo na query).
    }

    await processInboundMpWebhook(getDb(), {
      xSignature: request.headers.get("x-signature"),
      xRequestId: request.headers.get("x-request-id"),
      body,
      rawDataId,
    });
  } catch (error) {
    // Nunca propaga: 200 mesmo assim; a conciliação diária cobre a perda.
    console.error("[webhook mp] falha ao registrar evento inbound", error);
  }

  return NextResponse.json({ ok: true });
}

// O MP faz um GET de teste ao configurar a URL do webhook.
export async function GET(): Promise<NextResponse> {
  return new NextResponse("ok", { status: 200 });
}
