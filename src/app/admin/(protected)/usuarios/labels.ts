// Rótulos de exibição da área de usuários (puro, sem I/O).
//
// Os tipos são repetidos aqui de propósito, em vez de importados de
// `@/services/users`: este módulo também é lido por componentes de tela, e
// importar o service arrastaria banco e `node:crypto` para o navegador.

import type { BadgeTone } from "@/components/ui/badge";

export type UserRole = "owner" | "staff";
export type UserStatus = "ativo" | "convite_pendente" | "desativado";

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: "Proprietário",
  staff: "Funcionário",
};

export const ROLE_TONES: Record<UserRole, BadgeTone> = {
  owner: "info",
  staff: "neutral",
};

export const STATUS_LABELS: Record<UserStatus, string> = {
  ativo: "Ativo",
  convite_pendente: "Convite pendente",
  desativado: "Desativado",
};

export const STATUS_TONES: Record<UserStatus, BadgeTone> = {
  ativo: "success",
  convite_pendente: "warning",
  desativado: "neutral",
};

/** Ações do audit desta área, em linguagem de dono de loja. */
export const USER_ACTION_LABELS: Record<string, string> = {
  "user.create": "Acesso criado",
  "user.update": "Dados alterados",
  "user.activate": "Acesso ativado",
  "user.deactivate": "Acesso desativado",
  "user.password_reset": "Senha redefinida pelo proprietário",
  "user.password_reset_requested": "Pediu recuperação de senha",
  "user.password_changed": "Senha alterada pela própria pessoa",
};

export function userActionLabel(action: string): string {
  return USER_ACTION_LABELS[action] ?? action;
}
