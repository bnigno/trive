// A lista de usuários do painel como a tela precisa: filtro por texto/papel/
// situação e o resumo dos cards. Puro — recebe os itens já com a situação
// derivada pelo service e não sabe de banco nem de relógio (o `now` entra).
import type { AdminRole } from "./access";

/** Situação mostrada na lista: derivada de `is_active` + histórico do audit. */
export const USER_STATUSES = ["ativo", "convite_pendente", "desativado"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export type DirectoryUser = {
  email: string;
  fullName: string | null;
  role: AdminRole;
  status: UserStatus;
  lastSeenAt: Date | null;
};

export type UserFilters = {
  /** Casa nome OU e-mail, sem diferenciar maiúsculas nem acentos. */
  q?: string;
  role?: AdminRole;
  status?: UserStatus;
};

export const RECENTLY_ACTIVE_WINDOW_MS = 7 * 86_400_000;

export type UsersSummary = {
  total: number;
  /** Situação "ativo" (com senha e acesso ligado). */
  active: number;
  /** Papéis entre os ativos: quem de fato consegue entrar hoje. */
  owners: number;
  staff: number;
  pendingInvites: number;
  deactivated: number;
  /** Não desativados vistos nos últimos 7 dias. */
  activeLast7Days: number;
};

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function filterUsers<T extends DirectoryUser>(
  items: readonly T[],
  filters: UserFilters,
): T[] {
  const needle = filters.q ? fold(filters.q) : "";
  return items.filter((item) => {
    if (filters.role && item.role !== filters.role) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (needle) {
      const haystack = `${fold(item.fullName ?? "")} ${fold(item.email)}`;
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function summarizeUsers(
  items: readonly DirectoryUser[],
  { now }: { now: Date },
): UsersSummary {
  const recentSince = now.getTime() - RECENTLY_ACTIVE_WINDOW_MS;
  const summary: UsersSummary = {
    total: items.length,
    active: 0,
    owners: 0,
    staff: 0,
    pendingInvites: 0,
    deactivated: 0,
    activeLast7Days: 0,
  };
  for (const item of items) {
    if (item.status === "desativado") {
      summary.deactivated += 1;
      continue;
    }
    if (item.status === "ativo") {
      summary.active += 1;
      if (item.role === "owner") summary.owners += 1;
      else summary.staff += 1;
    }
    if (item.status === "convite_pendente") summary.pendingInvites += 1;
    if (item.lastSeenAt && item.lastSeenAt.getTime() >= recentSince) {
      summary.activeLast7Days += 1;
    }
  }
  return summary;
}
