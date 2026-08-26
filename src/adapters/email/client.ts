// Adapter REAL do Resend via fetch nativo (sem SDK — menos dependência, e a
// resposta é validada com Zod na fronteira). Usado apenas com
// ADAPTER_MODE=real; nos testes e em dev o FakeEmailProvider cobre o fluxo.
import { z } from "zod";

import type { EmailProvider, OutgoingEmail, SentEmail } from "./index";

const RESEND_API_URL = "https://api.resend.com/emails";

// Fronteira com o vendor: só o `id` nos interessa — resposta fora desse
// formato indica problema na integração e deve falhar alto.
const resendSuccessSchema = z.object({ id: z.string().min(1) });

const resendErrorSchema = z.object({ message: z.string() });

export class ResendEmailProvider implements EmailProvider {
  private readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  async send(email: OutgoingEmail): Promise<SentEmail> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error(
        "RESEND_API_KEY ausente. Configure a variável de ambiente para enviar " +
          "e-mails reais, ou use ADAPTER_MODE=fake.",
      );
    }
    const from = process.env.EMAIL_FROM;
    if (!from) {
      throw new Error(
        "EMAIL_FROM ausente. Configure o remetente dos e-mails (ex.: " +
          '"Loja <contato@sualoja.com.br>") para enviar e-mails reais.',
      );
    }

    const response = await this.fetchFn(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        ...(email.text !== undefined ? { text: email.text } : {}),
        // A API REST do Resend usa snake_case aqui (`reply_to`), diferente do
        // SDK. Sem esta chave a resposta do cliente volta para o EMAIL_FROM,
        // que pode não ser a caixa lida por IMAP.
        ...(email.replyTo !== undefined ? { reply_to: email.replyTo } : {}),
        ...(email.cc !== undefined && email.cc.length > 0
          ? { cc: email.cc }
          : {}),
        // In-Reply-To/References passam por aqui: sem eles o Gmail do cliente
        // não encaixa a resposta na conversa original — vira conversa solta.
        ...(email.headers !== undefined &&
        Object.keys(email.headers).length > 0
          ? { headers: email.headers }
          : {}),
      }),
    });

    if (!response.ok) {
      let detail: string | null = null;
      try {
        const parsed = resendErrorSchema.safeParse(await response.json());
        if (parsed.success) detail = parsed.data.message;
      } catch {
        // Corpo não-JSON: seguimos só com o status HTTP.
      }
      throw new Error(
        `Falha ao enviar e-mail via Resend (HTTP ${response.status})` +
          (detail ? `: ${detail}` : "."),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const parsed = resendSuccessSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(
        "Resposta inesperada da API do Resend: o campo `id` do e-mail enviado " +
          "não veio no corpo. Verifique a integração.",
      );
    }
    return { providerMessageId: parsed.data.id };
  }
}
