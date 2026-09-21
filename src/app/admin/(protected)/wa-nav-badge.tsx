"use client";

// Crachá de Conversas no menu: lê o store que o avisador (ou o chat)
// alimenta — este componente monta duas vezes (lateral e gaveta do celular)
// e não pode ter poll próprio. Ouro quando alguém espera por você; neutro
// quando são só mensagens que a vendedora está cuidando.
import { NavCount } from "./nav-count";
import { useWaUnseen } from "./wa-unseen-store";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function WaNavBadge() {
  const { awaitingOwner, withNewMessages, suggestionCount } = useWaUnseen();
  const total = withNewMessages + suggestionCount;
  if (total === 0) return null;

  const withSeller = withNewMessages - awaitingOwner;
  const parts = [
    awaitingOwner > 0 ? `${awaitingOwner} esperando por você` : null,
    withSeller > 0 ? `${withSeller} com a vendedora` : null,
    suggestionCount > 0 ? plural(suggestionCount, "sugestão da vendedora", "sugestões da vendedora") : null,
  ].filter((part): part is string => part !== null);

  return (
    <NavCount
      count={total}
      tone={awaitingOwner > 0 ? "gold" : "neutral"}
      title={parts.join(" · ")}
      srLabel=" conversas com mensagem nova"
    />
  );
}
