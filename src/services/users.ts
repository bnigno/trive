// Serviço dos usuários do painel: quem entra, com que papel, e como recupera
// o acesso quando perde a senha. É o único lugar que escreve na tabela
// `users` — nem o login nem as telas mexem nela.
//
// ESCRITA DUPLA (provedor de identidade → Postgres). `users.id` É o id da
// conta de acesso, então a conta precisa existir ANTES da linha. Por isso a
// ordem é: valida o ator pelo banco → cria/adota a conta no provedor (fora de
// transação, porque chamada de rede não pertence a transação) → grava a linha
// e o audit numa transação só → se a transação falhar, desfaz a conta.
import { randomBytes } from "node:crypto";

import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";

import type { EmailProvider } from "@/adapters/email";
import {
  IdentityError,
  type AccessLinkType,
  type IdentityProvider,
  type IdentityUser,
} from "@/adapters/identity";
import { auditLog, users } from "@/db/schema";
import {
  accessInviteEmail,
  passwordRecoveryEmail,
  type EmailTemplate,
} from "@/emails/templates";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { siteUrl } from "@/lib/site-url";
import { ServiceError, type ServiceDb } from "./catalog";
import { getSettingsMap } from "./settings";

export { ServiceError };

// ---------------------------------------------------------------------------
// Tipos e constantes
// ---------------------------------------------------------------------------

/**
 * Dependências externas injetadas. `email: null` significa que NÃO existe
 * canal de e-mail configurado: nada é enviado e nenhum fluxo quebra por isso
 * (o dono entrega o link/senha pela própria tela). Quem monta as deps é a
 * action, com `isEmailConfigured()`.
 */
export type UsersDeps = {
  identity: IdentityProvider;
  email: EmailProvider | null;
};

export const USER_ROLES = ["owner", "staff"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Modo de entrega do acesso na criação: link de convite ou senha provisória. */
export const CREATE_USER_MODES = ["invite", "password"] as const;
export type CreateUserMode = (typeof CREATE_USER_MODES)[number];

/** Modo de redefinição feita pelo dono: link de recuperação ou senha nova. */
export const RESET_MODES = ["link", "password"] as const;
export type ResetMode = (typeof RESET_MODES)[number];

/** Situação mostrada na lista: derivada de `is_active` + histórico do audit. */
export const USER_STATUSES = ["ativo", "convite_pendente", "desativado"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export type UserSummary = {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: Date;
};

export type UserListItem = UserSummary & { status: UserStatus };

export type CreateUserResult = {
  user: UserSummary;
  mode: CreateUserMode;
  /** Senha provisória em texto: existe só nesta resposta, nunca é gravada. */
  temporaryPassword: string | null;
  /** Link pronto para copiar (modo convite). */
  accessUrl: string | null;
  emailSent: boolean;
  /** true = havia conta órfã no provedor e ela foi reaproveitada. */
  adopted: boolean;
};

export type ResetUserPasswordResult = {
  user: UserSummary;
  mode: ResetMode;
  temporaryPassword: string | null;
  accessUrl: string | null;
  emailSent: boolean;
};

/**
 * Resposta do self-service. `enviado` é DELIBERADAMENTE genérico: cobre
 * "mandamos o link", "esse e-mail não existe", "esse acesso está desativado"
 * e "já pediu demais na última hora" — distinguir esses casos entregaria de
 * graça a lista de quem tem conta no painel. `email_nao_configurado` é uma
 * condição global da instalação (não fala de nenhuma pessoa), então pode ser
 * dita com todas as letras — em autenticação, skip silencioso é pior.
 */
export type RequestPasswordResetResult = {
  status: "enviado" | "email_nao_configurado";
};

const DEFAULT_STORE_NAME = STORE_NAME_DEFAULT;

/** Teto de pedidos de recuperação por conta, por hora (contado no audit). */
const PASSWORD_RESET_MAX_PER_HOUR = 3;
const PASSWORD_RESET_WINDOW_MS = 60 * 60 * 1000;

const STATUS_AUDIT_ACTIONS = [
  "user.create",
  "user.password_reset",
  "user.password_changed",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const emailSchema = z.string().trim().toLowerCase().pipe(z.email("E-mail inválido."));

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join("\n");
}

function mapUserUniqueViolation(error: unknown): ServiceError | null {
  if (errorChainText(error).includes("users_email_unique")) {
    return new ServiceError(
      "email_duplicado",
      "Já existe um usuário do painel com este e-mail.",
    );
  }
  return null;
}

/** Traduz a falha do provedor para o erro que as telas já sabem mostrar. */
const IDENTITY_ERROR_CODES: Record<IdentityError["code"], string> = {
  email_ja_existe: "email_duplicado",
  usuario_nao_encontrado: "acesso_nao_encontrado",
  nao_configurado: "identidade_nao_configurada",
  indisponivel: "identidade_indisponivel",
};

function rethrowAsServiceError(error: unknown): never {
  if (error instanceof IdentityError) {
    throw new ServiceError(IDENTITY_ERROR_CODES[error.code], error.message);
  }
  throw error;
}

/** Senha provisória forte o bastante e ainda ditável por telefone. */
function generateTemporaryPassword(): string {
  return `Trv-${randomBytes(9).toString("base64url")}`;
}

/** Link NOSSO (token_hash + verifyOtp), que funciona em qualquer dispositivo. */
function buildAccessUrl(type: AccessLinkType, tokenHash: string): string {
  return `${siteUrl()}/admin/acesso?token_hash=${encodeURIComponent(tokenHash)}&type=${type}`;
}

function toRole(role: string): UserRole {
  return role === "owner" ? "owner" : "staff";
}

type UserRow = typeof users.$inferSelect;

function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: toRole(row.role),
    isActive: row.isActive,
    createdAt: row.createdAt,
  };
}

type AuditEntry = {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

async function writeAudit(db: ServiceDb, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: entry.actorId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}

async function getStoreName(db: ServiceDb): Promise<string> {
  const map = await getSettingsMap(db, ["store_name"]);
  const value = map["store_name"];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : DEFAULT_STORE_NAME;
}

/**
 * Envio best-effort, sempre DEPOIS do commit.
 *
 * Exceção consciente à regra 5 (efeito externo via outbox): o payload destes
 * e-mails é uma CREDENCIAL em texto — guardá-lo em `outbox_events` deixaria o
 * link de acesso legível para sempre no banco. Além disso o dono precisa do
 * resultado na hora: o link/senha já está na tela dele e o e-mail é só
 * conveniência, então falha de envio não pode desfazer o que foi gravado nem
 * derrubar a operação.
 */
async function trySendEmail(
  provider: EmailProvider | null,
  to: string,
  template: EmailTemplate,
): Promise<boolean> {
  if (!provider) return false;
  try {
    await provider.send({
      to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
    return true;
  } catch (error) {
    console.warn("[users] falha ao enviar e-mail de acesso:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guardas de segurança
// ---------------------------------------------------------------------------

/**
 * Papel lido do BANCO, nunca do chamador: a sessão pode ter sido aberta
 * quando a pessoa ainda era proprietária, e um POST forjado pode mandar
 * qualquer `actorId`. Ator desativado também não gerencia ninguém.
 */
async function assertActorIsOwner(
  db: ServiceDb,
  actorId: string,
): Promise<UserRow> {
  const [actor] = await db
    .select()
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);

  if (!actor || !actor.isActive || toRole(actor.role) !== "owner") {
    throw new ServiceError(
      "nao_autorizado",
      "Apenas o proprietário pode gerenciar os usuários do painel.",
    );
  }
  return actor;
}

async function requireUserRow(db: ServiceDb, userId: string): Promise<UserRow> {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) {
    throw new ServiceError("nao_encontrado", "Usuário não encontrado.");
  }
  return row;
}

/**
 * Invariante que trava o sistema inteiro se for quebrada: sem proprietário
 * ativo ninguém entra no painel para consertar (e o alerta de WhatsApp fica
 * sem destinatário). Vem ANTES das regras de "não faça isso consigo mesmo"
 * porque a mensagem dela é a única que ensina a saída: promova outra pessoa.
 */
async function assertNotLastActiveOwner(
  db: ServiceDb,
  target: UserRow,
): Promise<void> {
  if (!target.isActive || toRole(target.role) !== "owner") return;

  const [row] = await db
    .select({ total: sql<string | number>`count(*)` })
    .from(users)
    .where(
      and(
        eq(users.role, "owner"),
        eq(users.isActive, true),
        ne(users.id, target.id),
      ),
    );

  if (Number(row?.total ?? 0) === 0) {
    throw new ServiceError(
      "ultimo_owner",
      "Este é o único proprietário ativo. Torne outra pessoa proprietária " +
        "antes de mudar ou desativar este acesso.",
    );
  }
}

async function assertEmailIsFree(db: ServiceDb, email: string): Promise<void> {
  // lower() dos dois lados: o UNIQUE do Postgres diferencia maiúsculas, então
  // "Ana@loja.com" passaria por cima de "ana@loja.com" e criaria dois acessos
  // para a mesma pessoa.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  if (existing) {
    throw new ServiceError(
      "email_duplicado",
      "Já existe um usuário do painel com este e-mail.",
    );
  }
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

const createUserSchema = z.object({
  actorId: z.uuid(),
  email: emailSchema,
  fullName: z.string().trim().min(1, "Informe o nome da pessoa."),
  role: z.enum(USER_ROLES),
  mode: z.enum(CREATE_USER_MODES),
  /** Só é honrado no modo convite (ver comentário em createUser). */
  sendEmail: z.boolean().optional(),
});

export type CreateUserInput = z.input<typeof createUserSchema>;

type ProvisionedAccess = {
  account: IdentityUser;
  /** A conta já existia no provedor e foi reaproveitada. */
  adopted: boolean;
  temporaryPassword: string | null;
  accessUrl: string | null;
};

/**
 * Cria (ou ADOTA) a conta no provedor. Adoção é o caso comum, não a exceção:
 * quem foi criado pelo script legado, ou por uma tentativa que morreu no meio
 * da escrita dupla, já tem conta lá e nenhuma linha aqui. Recusar seria
 * trancar o e-mail para sempre.
 */
async function provisionAccess(
  identity: IdentityProvider,
  input: { email: string; fullName: string; mode: CreateUserMode },
): Promise<ProvisionedAccess> {
  const existing = await identity.findByEmail(input.email);

  // Conta órfã banida (desativada num cadastro anterior): reativa, senão a
  // pessoa recebe o convite e mesmo assim não consegue entrar.
  if (existing?.banned) {
    await identity.setBanned(existing.id, false);
  }

  if (input.mode === "password") {
    const temporaryPassword = generateTemporaryPassword();
    if (existing) {
      await identity.setPassword(existing.id, temporaryPassword);
      return {
        account: existing,
        adopted: true,
        temporaryPassword,
        accessUrl: null,
      };
    }
    const account = await identity.createUser({
      email: input.email,
      fullName: input.fullName,
      password: temporaryPassword,
      emailConfirm: true,
    });
    return { account, adopted: false, temporaryPassword, accessUrl: null };
  }

  // "invite" cria a conta quando o e-mail é novo e reenvia quando a conta
  // existe mas nunca foi confirmada; para conta JÁ confirmada o GoTrue só
  // aceita "recovery" (o adapter espelha isso).
  const type: AccessLinkType = existing?.emailConfirmedAt ? "recovery" : "invite";
  const link = await identity.generateAccessLink({ email: input.email, type });
  return {
    account: link.user,
    adopted: existing !== null,
    temporaryPassword: null,
    accessUrl: buildAccessUrl(link.type, link.tokenHash),
  };
}

/**
 * Desfaz o que NÓS criamos quando a gravação falhou. Conta adotada não é
 * apagada: ela já existia antes desta chamada e apagá-la destruiria um acesso
 * que não é nosso — e o próximo cadastro do mesmo e-mail a adota de novo.
 */
async function compensateAccess(
  identity: IdentityProvider,
  provisioned: ProvisionedAccess,
  cause: unknown,
): Promise<void> {
  if (provisioned.adopted) return;
  try {
    await identity.deleteUser(provisioned.account.id);
  } catch (cleanupError) {
    console.warn("[users] falha ao desfazer a conta de acesso:", cleanupError);
    const orphan = new ServiceError(
      "acesso_orfao",
      "A conta de acesso foi criada, mas o cadastro no sistema falhou e não " +
        "consegui desfazer. Cadastre a pessoa de novo com o mesmo e-mail: o " +
        "sistema reaproveita a conta que ficou.",
    );
    orphan.cause = cause;
    throw orphan;
  }
}

export async function createUser(
  db: ServiceDb,
  deps: UsersDeps,
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const parsed = createUserSchema.parse(input);
  const actor = await assertActorIsOwner(db, parsed.actorId);
  await assertEmailIsFree(db, parsed.email);

  let provisioned: ProvisionedAccess;
  try {
    provisioned = await provisionAccess(deps.identity, {
      email: parsed.email,
      fullName: parsed.fullName,
      mode: parsed.mode,
    });
  } catch (error) {
    rethrowAsServiceError(error);
  }

  let created: UserRow;
  try {
    created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          id: provisioned.account.id,
          email: parsed.email,
          fullName: parsed.fullName,
          role: parsed.role,
          isActive: true,
        })
        .returning();

      await writeAudit(tx, {
        actorId: actor.id,
        action: "user.create",
        entityType: "user",
        entityId: row.id,
        // Sem senha e sem token: audit é histórico, não cofre de credencial.
        after: {
          email: row.email,
          fullName: row.fullName,
          role: row.role,
          mode: parsed.mode,
          adopted: provisioned.adopted,
        },
      });

      return row;
    });
  } catch (error) {
    await compensateAccess(deps.identity, provisioned, error);
    throw mapUserUniqueViolation(error) ?? error;
  }

  // Senha provisória NUNCA sai por e-mail: seria uma credencial em texto na
  // caixa de entrada. O dono entrega pelo canal que ele controla (a tela).
  let emailSent = false;
  if (parsed.mode === "invite" && parsed.sendEmail && provisioned.accessUrl) {
    const template = accessInviteEmail({
      fullName: created.fullName,
      storeName: await getStoreName(db),
      inviteUrl: provisioned.accessUrl,
      invitedByName: actor.fullName,
    });
    emailSent = await trySendEmail(deps.email, created.email, template);
  }

  return {
    user: toUserSummary(created),
    mode: parsed.mode,
    temporaryPassword: provisioned.temporaryPassword,
    accessUrl: provisioned.accessUrl,
    emailSent,
    adopted: provisioned.adopted,
  };
}

// ---------------------------------------------------------------------------
// Edição e estado
// ---------------------------------------------------------------------------

const updateUserSchema = z.object({
  actorId: z.uuid(),
  userId: z.uuid(),
  fullName: z.string().trim().min(1, "Informe o nome da pessoa.").optional(),
  role: z.enum(USER_ROLES).optional(),
});

export type UpdateUserInput = z.input<typeof updateUserSchema>;

/**
 * Muda nome e papel. E-mail NÃO muda na v1: ele é a identidade da conta no
 * provedor, e trocar dos dois lados sem transação distribuída é justamente o
 * jeito de perder o acesso de alguém.
 */
export async function updateUser(
  db: ServiceDb,
  input: UpdateUserInput,
): Promise<UserSummary> {
  const parsed = updateUserSchema.parse(input);

  return db.transaction(async (tx) => {
    const actor = await assertActorIsOwner(tx, parsed.actorId);
    const current = await requireUserRow(tx, parsed.userId);

    const patch: { fullName?: string; role?: UserRole } = {};
    if (parsed.fullName !== undefined && parsed.fullName !== current.fullName) {
      patch.fullName = parsed.fullName;
    }
    if (parsed.role !== undefined && parsed.role !== toRole(current.role)) {
      patch.role = parsed.role;
    }
    if (Object.keys(patch).length === 0) return toUserSummary(current);

    if (patch.role === "staff") {
      await assertNotLastActiveOwner(tx, current);
      if (current.id === actor.id) {
        throw new ServiceError(
          "auto_rebaixamento",
          "Você não pode tirar o seu próprio acesso de proprietário. Peça " +
            "para outro proprietário fazer isso.",
        );
      }
    }

    const [updated] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, current.id))
      .returning();

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      before[key] = current[key];
      after[key] = updated[key];
    }
    await writeAudit(tx, {
      actorId: actor.id,
      action: "user.update",
      entityType: "user",
      entityId: updated.id,
      before,
      after,
    });

    return toUserSummary(updated);
  });
}

const setUserActiveSchema = z.object({
  actorId: z.uuid(),
  userId: z.uuid(),
  isActive: z.boolean(),
  reason: z.string().trim().min(1).optional(),
});

export type SetUserActiveInput = z.input<typeof setUserActiveSchema>;

/**
 * Bane/desbane no provedor. Desativar NUNCA pode ficar bloqueado por uma
 * conta que sumiu do provedor: a linha inativa em `users` sozinha já barra o
 * login. Ativar é o contrário — sem conta lá não existe acesso nenhum para
 * liberar, então o erro sobe para o dono resolver.
 */
async function setAccountBanned(
  identity: IdentityProvider,
  userId: string,
  banned: boolean,
): Promise<void> {
  try {
    await identity.setBanned(userId, banned);
  } catch (error) {
    if (
      banned &&
      error instanceof IdentityError &&
      error.code === "usuario_nao_encontrado"
    ) {
      console.warn(
        "[users] conta de acesso inexistente ao desativar; segue só no banco:",
        userId,
      );
      return;
    }
    rethrowAsServiceError(error);
  }
}

export async function setUserActive(
  db: ServiceDb,
  deps: UsersDeps,
  input: SetUserActiveInput,
): Promise<UserSummary> {
  const parsed = setUserActiveSchema.parse(input);
  const actor = await assertActorIsOwner(db, parsed.actorId);
  const current = await requireUserRow(db, parsed.userId);

  if (current.isActive === parsed.isActive) return toUserSummary(current);

  if (!parsed.isActive) {
    await assertNotLastActiveOwner(db, current);
    if (current.id === actor.id) {
      throw new ServiceError(
        "auto_desativacao",
        "Você não pode desativar o seu próprio acesso. Peça para outro " +
          "proprietário fazer isso.",
      );
    }
  }

  // Provedor primeiro nas duas direções porque é o lado que falha SEGURO: se
  // o Postgres não gravar depois, sobra alguém banido lá e ativo aqui (não
  // entra) ou desbanido lá e inativo aqui (também não entra).
  await setAccountBanned(deps.identity, current.id, !parsed.isActive);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ isActive: parsed.isActive })
      .where(eq(users.id, current.id))
      .returning();

    await writeAudit(tx, {
      actorId: actor.id,
      action: parsed.isActive ? "user.activate" : "user.deactivate",
      entityType: "user",
      entityId: updated.id,
      before: { isActive: current.isActive },
      after: { isActive: updated.isActive },
      reason: parsed.reason,
    });

    return toUserSummary(updated);
  });
}

// ---------------------------------------------------------------------------
// Senha
// ---------------------------------------------------------------------------

const resetUserPasswordSchema = z.object({
  actorId: z.uuid(),
  userId: z.uuid(),
  mode: z.enum(RESET_MODES),
  sendEmail: z.boolean().optional(),
});

export type ResetUserPasswordInput = z.input<typeof resetUserPasswordSchema>;

/** Redefinição feita PELO DONO (a self-service é `requestPasswordReset`). */
export async function resetUserPassword(
  db: ServiceDb,
  deps: UsersDeps,
  input: ResetUserPasswordInput,
): Promise<ResetUserPasswordResult> {
  const parsed = resetUserPasswordSchema.parse(input);
  const actor = await assertActorIsOwner(db, parsed.actorId);
  const target = await requireUserRow(db, parsed.userId);

  if (!target.isActive) {
    throw new ServiceError(
      "usuario_inativo",
      "Este acesso está desativado. Ative o acesso antes de redefinir a senha.",
    );
  }

  let temporaryPassword: string | null = null;
  let accessUrl: string | null = null;
  try {
    if (parsed.mode === "password") {
      temporaryPassword = generateTemporaryPassword();
      // `users.id` É o id da conta de acesso: não precisa procurar por e-mail.
      await deps.identity.setPassword(target.id, temporaryPassword);
    } else {
      const link = await deps.identity.generateAccessLink({
        email: target.email,
        type: "recovery",
      });
      accessUrl = buildAccessUrl(link.type, link.tokenHash);
    }
  } catch (error) {
    rethrowAsServiceError(error);
  }

  await writeAudit(db, {
    actorId: actor.id,
    action: "user.password_reset",
    entityType: "user",
    entityId: target.id,
    after: { mode: parsed.mode },
  });

  let emailSent = false;
  if (parsed.mode === "link" && parsed.sendEmail && accessUrl) {
    const template = passwordRecoveryEmail({
      fullName: target.fullName,
      storeName: await getStoreName(db),
      recoveryUrl: accessUrl,
    });
    emailSent = await trySendEmail(deps.email, target.email, template);
  }

  return {
    user: toUserSummary(target),
    mode: parsed.mode,
    temporaryPassword,
    accessUrl,
    emailSent,
  };
}

const requestPasswordResetSchema = z.object({ email: emailSchema });

export type RequestPasswordResetInput = z.input<typeof requestPasswordResetSchema>;

/**
 * Self-service, chamado por página PÚBLICA (`/admin/esqueci-senha`).
 *
 * Duas regras mandam aqui:
 * 1. Anti-enumeração — e-mail desconhecido ou acesso desativado devolvem o
 *    mesmo `enviado`, sem gravar audit e sem tocar no provedor. Nem falha de
 *    envio sobe como erro: só existe envio para quem tem conta, então um erro
 *    visível já denunciaria que aquele e-mail é de alguém.
 * 2. Limite de {PASSWORD_RESET_MAX_PER_HOUR} por hora, contado nos audits da
 *    própria conta — sem isso a tela vira botão de spam para a caixa de
 *    entrada de outra pessoa. Pedido bloqueado não grava audit, senão o
 *    atacante empurraria a janela para sempre.
 *
 * O link NUNCA volta na resposta: quem pede pela tela pública não pode receber
 * o acesso de volta ali mesmo.
 */
export async function requestPasswordReset(
  db: ServiceDb,
  deps: UsersDeps,
  input: RequestPasswordResetInput,
): Promise<RequestPasswordResetResult> {
  const parsed = requestPasswordResetSchema.parse(input);

  if (!deps.email) return { status: "email_nao_configurado" };

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${parsed.email}`)
    .limit(1);

  if (!user || !user.isActive) return { status: "enviado" };

  const since = new Date(Date.now() - PASSWORD_RESET_WINDOW_MS);
  const [recent] = await db
    .select({ total: sql<string | number>`count(*)` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "user.password_reset_requested"),
        eq(auditLog.entityId, user.id),
        gt(auditLog.createdAt, since),
      ),
    );
  if (Number(recent?.total ?? 0) >= PASSWORD_RESET_MAX_PER_HOUR) {
    return { status: "enviado" };
  }

  let accessUrl: string;
  try {
    const link = await deps.identity.generateAccessLink({
      email: user.email,
      type: "recovery",
    });
    accessUrl = buildAccessUrl(link.type, link.tokenHash);
  } catch (error) {
    // Linha em `users` sem conta no provedor: nada a enviar, e contar isso
    // para quem pediu também entregaria informação.
    if (
      error instanceof IdentityError &&
      error.code === "usuario_nao_encontrado"
    ) {
      return { status: "enviado" };
    }
    rethrowAsServiceError(error);
  }

  // Audit ANTES do envio: ele é o contador do limite, e um envio que falha no
  // meio não pode zerar a proteção.
  await writeAudit(db, {
    actorId: user.id,
    action: "user.password_reset_requested",
    entityType: "user",
    entityId: user.id,
  });

  const template = passwordRecoveryEmail({
    fullName: user.fullName,
    storeName: await getStoreName(db),
    recoveryUrl: accessUrl,
  });
  await trySendEmail(deps.email, user.email, template);

  return { status: "enviado" };
}

const recordPasswordChangedSchema = z.object({ userId: z.uuid() });

export type RecordPasswordChangedInput = z.input<
  typeof recordPasswordChangedSchema
>;

/**
 * Registro de que a própria pessoa trocou a senha (chamado por
 * `/admin/nova-senha` depois que o provedor confirmou). É o que tira a conta
 * da situação "convite pendente" na lista.
 */
export async function recordPasswordChanged(
  db: ServiceDb,
  input: RecordPasswordChangedInput,
): Promise<void> {
  const parsed = recordPasswordChangedSchema.parse(input);
  const user = await requireUserRow(db, parsed.userId);

  await writeAudit(db, {
    actorId: user.id,
    action: "user.password_changed",
    entityType: "user",
    entityId: user.id,
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

type StatusAudit = {
  entityId: string | null;
  action: string;
  after: unknown;
  createdAt: Date;
};

function readMode(after: unknown): string | null {
  if (typeof after !== "object" || after === null) return null;
  const mode = (after as { mode?: unknown }).mode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Situação derivada, sem coluna nova: "convite pendente" é ter um
 * `user.create` em modo convite sem nenhuma senha definida depois dele. Quem
 * veio do script legado não tem audit de criação e aparece como ativo — o que
 * é verdade, essas contas já têm senha.
 */
function deriveStatus(
  user: { id: string; isActive: boolean },
  audits: StatusAudit[],
): UserStatus {
  if (!user.isActive) return "desativado";

  let invitedAt: number | null = null;
  let passwordSetAt: number | null = null;
  for (const audit of audits) {
    if (audit.entityId !== user.id) continue;
    const at = audit.createdAt.getTime();
    const mode = readMode(audit.after);
    if (audit.action === "user.create" && mode === "invite") {
      invitedAt = Math.max(invitedAt ?? 0, at);
    } else if (audit.action === "user.password_changed" || mode === "password") {
      passwordSetAt = Math.max(passwordSetAt ?? 0, at);
    }
  }

  if (invitedAt === null) return "ativo";
  return passwordSetAt !== null && passwordSetAt >= invitedAt
    ? "ativo"
    : "convite_pendente";
}

async function loadStatusAudits(
  db: ServiceDb,
  userIds: string[],
): Promise<StatusAudit[]> {
  if (userIds.length === 0) return [];
  return db
    .select({
      entityId: auditLog.entityId,
      action: auditLog.action,
      after: auditLog.after,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "user"),
        inArray(auditLog.action, [...STATUS_AUDIT_ACTIONS]),
        inArray(auditLog.entityId, userIds),
      ),
    );
}

export async function listUsers(db: ServiceDb): Promise<UserListItem[]> {
  const rows = await db
    .select()
    .from(users)
    .orderBy(sql`lower(coalesce(${users.fullName}, ${users.email}))`);

  const audits = await loadStatusAudits(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row) => ({
    ...toUserSummary(row),
    status: deriveStatus(row, audits),
  }));
}

export type UserHistoryEntry = {
  id: number;
  action: string;
  reason: string | null;
  createdAt: Date;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
};

export type UserDetail = UserListItem & { history: UserHistoryEntry[] };

export async function getUserDetail(
  db: ServiceDb,
  userId: string,
): Promise<UserDetail> {
  const parsedId = z.uuid().parse(userId);
  const row = await requireUserRow(db, parsedId);
  const audits = await loadStatusAudits(db, [row.id]);

  const history = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      reason: auditLog.reason,
      createdAt: auditLog.createdAt,
      actorId: auditLog.actorId,
      actorName: users.fullName,
      actorEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.entityType, "user"), eq(auditLog.entityId, row.id)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(20);

  return {
    ...toUserSummary(row),
    status: deriveStatus(row, audits),
    history,
  };
}
