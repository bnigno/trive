// Ponte servidor → navegador da caixa de e-mail: Date vira ISO 8601 e o anexo
// ganha o link de download. A página (RSC) e o poll usam esta MESMA função,
// então as duas entregam exatamente o mesmo formato — é o que permite ao
// cliente fazer upsert por id sem saber de onde veio a mensagem.
//
// Módulo de servidor: toca o adapter de storage. Só a página (RSC) e o route
// handler importam daqui — nunca um componente de navegador.
import { getFileStorage } from "@/adapters/storage";
import type {
  EmailAttachmentRef,
  EmailThreadListItem,
  EmailThreadMessage,
} from "@/services/email-inbox";
import type { InboxAttachment, InboxMessage, InboxThreadItem } from "./use-inbox-poll";

/**
 * Link do anexo. Sem storage configurado (ambiente sem as chaves) o construtor
 * do adapter estoura: preferimos anexo sem link a tela de erro — o resto do
 * e-mail continua legível e a UI mostra "arquivo indisponível".
 */
function attachmentUrlOrNull(path: string): string | null {
  try {
    return getFileStorage().publicUrl(path);
  } catch {
    return null;
  }
}

function toInboxAttachment(ref: EmailAttachmentRef): InboxAttachment {
  return {
    filename: ref.filename,
    contentType: ref.contentType,
    sizeBytes: ref.sizeBytes,
    url: attachmentUrlOrNull(ref.storagePath),
  };
}

export function toInboxMessage(message: EmailThreadMessage): InboxMessage {
  return {
    id: message.id,
    direction: message.direction,
    fromAddress: message.fromAddress,
    fromName: message.fromName,
    toAddresses: message.toAddresses,
    subject: message.subject,
    textBody: message.textBody,
    htmlBody: message.htmlBody,
    attachments: message.attachments.map(toInboxAttachment),
    status: message.status,
    errorDetail: message.errorDetail,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toInboxThreadItem(row: EmailThreadListItem): InboxThreadItem {
  return {
    id: row.id,
    subject: row.subject,
    participantEmail: row.participantEmail,
    participantName: row.participantName,
    customerName: row.customerName,
    status: row.status,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    lastMessageDirection: row.lastMessageDirection,
    lastMessageSnippet: row.lastMessageSnippet,
    unreadCount: row.unreadCount,
  };
}
