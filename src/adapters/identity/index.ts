// Contrato do provedor de IDENTIDADE (contas de acesso ao painel). Fica
// separado de `services/auth.ts` (sessão de quem já está logado): aqui é a
// administração das contas — criar, convidar, trocar senha, desativar.
//
// Regra do projeto: nenhum SDK de vendor sai daqui. O implementador real é
// `supabase.ts` (Admin API do GoTrue via fetch + Zod); em dev/teste o
// `fake.ts` cobre o fluxo inteiro sem rede.
import { getAdapterMode } from "../adapter-mode";
import { FakeIdentityProvider } from "./fake";
import { SupabaseIdentityProvider } from "./supabase";

export const IDENTITY_ERROR_CODES = [
  "email_ja_existe",
  "usuario_nao_encontrado",
  "nao_configurado",
  "indisponivel",
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

/**
 * Falha tratável do provedor de identidade. `code` é o que o service usa para
 * decidir; `message` já vem em pt-BR e pode ser mostrada ao dono.
 */
export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
  }
}

/** Conta de acesso como o provedor a enxerga (NÃO é a linha de `users`). */
export type IdentityUser = {
  /** É o mesmo id usado em `users.id` no nosso Postgres. */
  id: string;
  email: string;
  fullName: string | null;
  /** null = convite ainda não aceito (conta criada, e-mail não confirmado). */
  emailConfirmedAt: Date | null;
  /** Desativado no provedor (não consegue mais entrar). */
  banned: boolean;
  createdAt: Date | null;
};

export type CreateIdentityUserInput = {
  email: string;
  fullName?: string | null;
  /** Sem senha = conta criada só para receber convite. */
  password?: string;
  /**
   * Marca o e-mail como confirmado na criação (padrão: true). Com senha
   * provisória precisa ser true, senão a pessoa não consegue entrar sem
   * clicar em link nenhum.
   */
  emailConfirm?: boolean;
};

export type AccessLinkType = "invite" | "recovery";

export type GenerateAccessLinkInput = {
  email: string;
  type: AccessLinkType;
  /** Para onde o provedor deve mandar depois de validar (opcional). */
  redirectTo?: string;
};

export type AccessLink = {
  user: IdentityUser;
  type: AccessLinkType;
  /**
   * Token HASHEADO do e-mail. É COM ELE que montamos o nosso link
   * (`/admin/acesso?token_hash=...`) + `verifyOtp` — funciona em qualquer
   * dispositivo, diferente do fluxo implícito do `actionLink`.
   */
  tokenHash: string;
  /**
   * Link cru do vendor (fluxo implícito do GoTrue). NÃO usar na nossa UI: o
   * cliente `@supabase/ssr` está fixado em PKCE e cair nele lança erro.
   * Guardado só para diagnóstico.
   */
  actionLink: string;
};

export interface IdentityProvider {
  findByEmail(email: string): Promise<IdentityUser | null>;
  createUser(input: CreateIdentityUserInput): Promise<IdentityUser>;
  /**
   * Gera link de acesso SEM enviar e-mail (a entrega é nossa).
   *
   * Atenção ao comportamento do GoTrue, espelhado no fake:
   * - `invite` CRIA a conta quando o e-mail ainda não existe; se já existir
   *   uma conta confirmada, falha com `email_ja_existe`.
   * - `recovery` exige conta existente; senão falha com
   *   `usuario_nao_encontrado`.
   *
   * Ou seja: para quem já tem conta (inclusive conta órfã do script legado),
   * o tipo certo é `recovery`.
   */
  generateAccessLink(input: GenerateAccessLinkInput): Promise<AccessLink>;
  setPassword(userId: string, password: string): Promise<void>;
  setBanned(userId: string, banned: boolean): Promise<void>;
  /** Só para COMPENSAR uma criação que falhou depois; nunca para desativar. */
  deleteUser(userId: string): Promise<void>;
}

let instance: IdentityProvider | undefined;

export function getIdentityProvider(): IdentityProvider {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new SupabaseIdentityProvider()
        : new FakeIdentityProvider();
  }
  return instance;
}
