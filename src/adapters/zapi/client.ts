import { z } from "zod";
import type { MessagingProvider, OutboundTextMessage, SentMessage, SessionStatus } from "./index";

// Esboço da validação das respostas da Z-API (só os campos que consumimos).
// Confirmar contra a documentação oficial ao implementar na Fase 4.
export const zapiSendTextResponseSchema = z.object({
  messageId: z.string(),
});

export const zapiStatusResponseSchema = z.object({
  connected: z.boolean(),
});

export class ZapiMessagingProvider implements MessagingProvider {
  // Fase 4: fetch com ZAPI_INSTANCE_ID / ZAPI_INSTANCE_TOKEN / ZAPI_CLIENT_TOKEN,
  // parse com os schemas acima.

  async sendText(_message: OutboundTextMessage): Promise<SentMessage> {
    throw new Error("Adapter real da Z-API entra na Fase 4");
  }

  async getSessionStatus(): Promise<SessionStatus> {
    throw new Error("Adapter real da Z-API entra na Fase 4");
  }
}
