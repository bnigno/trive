// Ícones da área de usuários, separados de labels.ts (que é puro e pode ir
// para o navegador sem arrastar componentes).
import {
  Crown,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  Pencil,
  ShieldCheck,
  User,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react";

import type { UserRole } from "./labels";

export const ROLE_ICONS: Record<UserRole, LucideIcon> = {
  owner: Crown,
  staff: User,
};

/** Ícone por ação do audit; o `User` genérico cobre ação desconhecida. */
const USER_ACTION_ICONS: Record<string, LucideIcon> = {
  "user.create": UserPlus,
  "user.update": Pencil,
  "user.activate": UserCheck,
  "user.deactivate": UserX,
  "user.password_reset": KeyRound,
  "user.password_reset_requested": LockKeyhole,
  "user.password_changed": ShieldCheck,
};

export function userActionIcon(action: string): LucideIcon {
  return USER_ACTION_ICONS[action] ?? User;
}
