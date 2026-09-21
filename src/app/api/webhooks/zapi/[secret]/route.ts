import { after, NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { handlerReserveMs } from "@/core/queue/retry-policy";
import { INLINE_KICK_BUDGET_MS, runOutboxKick, WEBHOOK_INLINE_MAX_MS } from "@/queue/kick";
import { processZapiInbound } from "@/services/wa-inbound";

export const dynamic = "force-dynamic";
// A resposta da Lia sai nesta mesma invocação, depois do 200 (after): a
// função precisa viver até o turno terminar — mesmo teto de /api/inngest.
export const maxDuration = 60;

// Webhook da Z-API. O [secret] do path é a autenticação: mismatch devolve 404
// para não revelar que o endpoint existe. Fora isso SEMPRE 200 rápido — a
// verdade fica em inbound_events; o evento do outbox que a mensagem gerou
// roda logo depois de responder (after), com o kick do Inngest e o cron de
// varredura como redes de segurança (lambda morta no meio, deploy).
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ secret: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
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
    if ("outboxEventId" in result && typeof result.outboxEventId === "string") {
      const { outboxEventId } = result;
      // O que sobra da vida desta lambda (o registro pode ter esperado o turno
      // anterior da mesma conversa terminar): sem ~32 s pela frente o turno
      // não roda aqui — o kick ao Inngest, que o serviço já mandou depois do
      // commit, cuida dele numa função com 60 s inteiros.
      const budgetMs = Math.min(INLINE_KICK_BUDGET_MS, WEBHOOK_INLINE_MAX_MS - (Date.now() - startedAt));
      if (budgetMs >= handlerReserveMs("wa.bot_turn")) {
        after(async () => {
          try {
            const kick = await runOutboxKick(getDb(), { outboxEventId, source: "inline", budgetMs });
            console.info(`[webhook zapi] inline ${outboxEventId} → ${kick.target}`);
          } catch (error) {
            // Nunca vira 500 (a resposta já saiu): o kick e o cron entregam.
            console.error(`[webhook zapi] turno inline ${outboxEventId} falhou; o kick e o cron cobrem`, error);
          }
        });
      } else {
        console.info(`[webhook zapi] inline ${outboxEventId} pulado: sobravam ${budgetMs} ms da lambda; o kick cuida`);
      }
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
