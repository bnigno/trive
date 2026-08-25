import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { processZapiInbound } from "@/services/wa-inbound";

export const dynamic = "force-dynamic";

// Webhook da Z-API. O [secret] do path é a autenticação: mismatch devolve 404
// para não revelar que o endpoint existe. Fora isso SEMPRE 200 rápido — a
// verdade fica em inbound_events e o processamento real é assíncrono (outbox).
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ secret: string }> },
): Promise<NextResponse> {
  const { secret } = await context.params;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Corpo ausente ou não-JSON: o serviço trata como evento ignorável.
  }

  try {
    const result = await processZapiInbound(getDb(), {
      providedSecret: secret,
      clientToken: request.headers.get("client-token"),
      body,
    });

    if (result.action === "rejected" && result.rejected === "secret") {
      return new NextResponse("Not Found", { status: 404 });
    }
  } catch (error) {
    // Nunca propaga: 200 mesmo assim para a Z-API não desativar o webhook.
    console.error("[webhook zapi] falha ao registrar evento inbound", error);
  }

  return NextResponse.json({ ok: true });
}

// GET de verificação ao configurar a URL do webhook.
export async function GET(): Promise<NextResponse> {
  return new NextResponse("ok", { status: 200 });
}
