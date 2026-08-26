import { notFound, permanentRedirect } from "next/navigation";

// A thread agora vive na própria página de conversas (?c=<uuid>). Links
// antigos /conversas/<id> (favoritos, histórico, avisos por WhatsApp)
// continuam funcionando via redirect permanente.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WaConversationThreadRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // UUID inválido na URL não deve virar redirect com lixo nem erro 500.
  if (!UUID_RE.test(id)) notFound();
  permanentRedirect(`/admin/whatsapp/conversas?c=${id}`);
}
