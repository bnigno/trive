// "Atenção agora": o que está esperando alguém, numa lista só, do mais
// urgente para o mais tranquilo. Puro: recebe o dashboard e devolve linhas;
// o ícone de cada chave fica no componente.
import type { AdminDashboard } from "@/services/dashboard";

export type AttentionSeverity = "danger" | "warning" | "neutral";

export type AttentionRow = {
  key: string;
  label: string;
  count: number;
  hint: string;
  href: string;
  severity: AttentionSeverity;
};

const SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  danger: 0,
  warning: 1,
  neutral: 2,
};

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function buildAttentionRows(dashboard: AdminDashboard): AttentionRow[] {
  const { shared, owner } = dashboard;
  const rows: AttentionRow[] = [];

  if (shared.mustShipToday) {
    rows.push({
      key: "must-ship-today",
      label: "Precisam sair hoje",
      count: shared.mustShipToday,
      hint: "Pedidos com data marcada no limite.",
      href: "/admin/pedidos/data-marcada",
      severity: "danger",
    });
  }
  if (owner?.deadOutbox) {
    rows.push({
      key: "dead-outbox",
      label: "Fila com problemas",
      count: owner.deadOutbox,
      hint: "Eventos que falharam e precisam da sua atenção.",
      href: "/admin/fila",
      severity: "danger",
    });
  }
  if (shared.route && (shared.route.today > 0 || shared.route.late > 0)) {
    rows.push({
      key: "route",
      label: "Saem hoje (motoboy)",
      count: shared.route.today,
      hint: shared.route.late
        ? `${shared.route.late} ${plural(shared.route.late, "atrasado", "atrasados")} — abra a rota.`
        : "Pedidos com janela de entrega hoje.",
      href: "/admin/pedidos/rota",
      severity: shared.route.late ? "warning" : "neutral",
    });
  }
  if (shared.toDeliverCount) {
    const stale = shared.staleShipmentsCount ?? 0;
    rows.push({
      key: "to-deliver",
      label: "Para entregar",
      count: shared.toDeliverCount,
      hint: stale
        ? `${stale} ${plural(stale, "enviado", "enviados")} há 7+ dias sem confirmação — confira.`
        : "A caminho da cliente — registre a entrega com a foto.",
      href: "/admin/pedidos/entregar",
      severity: stale ? "warning" : "neutral",
    });
  }
  if (shared.toPackCount) {
    rows.push({
      key: "to-pack",
      label: "A embalar",
      count: shared.toPackCount,
      hint: "Pedidos pagos esperando a foto do pacote.",
      href: "/admin/pedidos/embalar",
      severity: "warning",
    });
  }
  if (owner?.pendingApprovals) {
    rows.push({
      key: "pending-approvals",
      label: "Aprovações de preço",
      count: owner.pendingApprovals,
      hint: "Preços aguardando a sua aprovação.",
      href: "/admin/precos/pendencias",
      severity: "warning",
    });
  }
  if (owner?.atelierFailed) {
    rows.push({
      key: "atelier-failed",
      label: "Chegadas com problema",
      count: owner.atelierFailed,
      hint: "Fotos + recado pelo WhatsApp que não viraram rascunho.",
      href: "/admin/produtos/chegadas",
      severity: "warning",
    });
  }
  if (owner?.pendingLooks) {
    rows.push({
      key: "pending-looks",
      label: "Fotos aguardando aprovação",
      count: owner.pendingLooks,
      hint: "Clientes que autorizaram a foto na página da peça.",
      href: "/admin/produtos/quem-vestiu",
      severity: "neutral",
    });
  }
  if (shared.lowStockCount) {
    rows.push({
      key: "low-stock",
      label: "Estoque baixo",
      count: shared.lowStockCount,
      hint: "Variações no limiar de alerta ou abaixo.",
      href: "/admin/estoque",
      severity: "neutral",
    });
  }
  // WhatsApp: quem espera por você (transferidas) é urgente; o resto é a
  // vendedora cuidando — informa, não cobra. Os dois links abrem "Não lidas".
  if (shared.attention?.conversationsAwaiting) {
    const awaiting = shared.attention.conversationsAwaiting;
    rows.push({
      key: "wa-awaiting",
      label: "Esperando por você no WhatsApp",
      count: awaiting,
      hint: `${plural(awaiting, "Conversa transferida", "Conversas transferidas")} com mensagem que você ainda não viu.`,
      href: "/admin/whatsapp/conversas?f=nao-lidas",
      severity: "warning",
    });
  }
  const withSeller = (shared.attention?.conversationsWithNewMessages ?? 0) - (shared.attention?.conversationsAwaiting ?? 0);
  if (withSeller > 0) {
    rows.push({
      key: "wa-new",
      label: "Mensagem nova com a vendedora",
      count: withSeller,
      hint: "A vendedora está respondendo; abra se quiser acompanhar.",
      href: "/admin/whatsapp/conversas?f=nao-lidas",
      severity: "neutral",
    });
  }
  // Para a equipe os e-mails já estão no painel de cima; para o dono entram aqui.
  if (owner && shared.attention?.emailThreadsAwaiting) {
    rows.push({
      key: "emails",
      label: "E-mails aguardando",
      count: shared.attention.emailThreadsAwaiting,
      hint: "Conversas por e-mail que ninguém abriu ainda.",
      href: "/admin/emails",
      severity: "neutral",
    });
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.row.severity] - SEVERITY_ORDER[b.row.severity] ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}
