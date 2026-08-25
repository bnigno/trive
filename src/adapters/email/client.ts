import type { EmailProvider, OutgoingEmail } from "./index";

export class ResendEmailProvider implements EmailProvider {
  // Fase 3: SDK `resend` (já instalado) com RESEND_API_KEY e remetente EMAIL_FROM;
  // o SDK já tipa a resposta, então a validação extra com Zod é dispensável aqui.

  async send(_email: OutgoingEmail): Promise<void> {
    throw new Error("Adapter real do Resend entra na Fase 3");
  }
}
