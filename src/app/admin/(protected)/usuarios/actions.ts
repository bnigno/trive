"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getEmailProvider, isEmailConfigured } from "@/adapters/email";
import { getIdentityProvider } from "@/adapters/identity";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import {
  CREATE_USER_MODES,
  RESET_MODES,
  ServiceError,
  USER_ROLES,
  createUser,
  resetUserPassword,
  setUserActive,
  updateUser,
  type UsersDeps,
} from "@/services/users";

export type FormState = {
  error?: string;
  success?: string;
  /**
   * Link de acesso ou senha provisória recém-gerados. Existe SÓ nesta
   * resposta: nunca é gravado no banco, nunca vai para log e some assim que a
   * página é recarregada.
   */
  access?: AccessResultData;
};

export type AccessResultData = {
  /** "link" = link de acesso; "password" = senha provisória. */
  kind: "link" | "password";
  userId: string;
  personName: string;
  email: string;
  accessUrl: string | null;
  temporaryPassword: string | null;
  /** Houve tentativa de envio por e-mail (só existe se o canal está ligado). */
  emailAttempted: boolean;
  emailSent: boolean;
  /** true = já existia uma conta de acesso com este e-mail e foi reaproveitada. */
  adopted: boolean;
};

/**
 * Dependências do service. `email: null` quando o canal não está configurado —
 * o cadastro continua funcionando inteiro pelo link/senha na tela.
 */
function usersDeps(): UsersDeps {
  return {
    identity: getIdentityProvider(),
    email: isEmailConfigured() ? getEmailProvider() : null,
  };
}

/** Extrai a mensagem pt-BR de erros conhecidos; genérica para o resto. */
function toErrorState(error: unknown): FormState {
  if (error instanceof ServiceError) {
    return { error: error.message };
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0]?.message;
    if (first) return { error: first };
  }
  console.error("[usuarios] erro inesperado:", error);
  return { error: "Algo deu errado, tente novamente." };
}

/** Campo de texto do form: string aparada ou undefined se vazio. */
function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const roleSchema = z.enum(USER_ROLES);
const createModeSchema = z.enum(CREATE_USER_MODES);
const resetModeSchema = z.enum(RESET_MODES);

// ---------------------------------------------------------------------------
// Criar usuário
// ---------------------------------------------------------------------------

export async function createUserAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireOwner("usuarios");

  const fullName = text(formData, "fullName");
  if (!fullName) return { error: "Informe o nome da pessoa." };

  const email = text(formData, "email");
  if (!email) return { error: "Informe o e-mail de acesso." };

  const role = roleSchema.safeParse(formData.get("role"));
  if (!role.success) return { error: "Escolha o papel desta pessoa." };

  const mode = createModeSchema.safeParse(formData.get("mode"));
  if (!mode.success) {
    return { error: "Escolha como a pessoa vai receber o acesso." };
  }

  // O rádio de convite por e-mail fica desabilitado na tela quando não há
  // canal, mas a decisão real é tomada aqui: form desabilitado não é proteção.
  const sendEmail = mode.data === "invite" && isEmailConfigured();

  let result: Awaited<ReturnType<typeof createUser>>;
  try {
    result = await createUser(getDb(), usersDeps(), {
      actorId: actor.id,
      email,
      fullName,
      role: role.data,
      mode: mode.data,
      sendEmail,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/usuarios");

  // Sem redirect de propósito: o link/senha aparece uma única vez e só existe
  // nesta resposta — sair da tela agora perderia o acesso da pessoa.
  return {
    success: `Acesso de ${result.user.fullName ?? result.user.email} criado.`,
    access: {
      kind: result.mode === "invite" ? "link" : "password",
      userId: result.user.id,
      personName: result.user.fullName ?? result.user.email,
      email: result.user.email,
      accessUrl: result.accessUrl,
      temporaryPassword: result.temporaryPassword,
      emailAttempted: sendEmail,
      emailSent: result.emailSent,
      adopted: result.adopted,
    },
  };
}

// ---------------------------------------------------------------------------
// Editar nome e papel
// ---------------------------------------------------------------------------

export async function updateUserAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireOwner("usuarios");

  const userId = z.uuid().safeParse(formData.get("userId"));
  if (!userId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const fullName = text(formData, "fullName");
  if (!fullName) return { error: "Informe o nome da pessoa." };

  const role = roleSchema.safeParse(formData.get("role"));
  if (!role.success) return { error: "Escolha o papel desta pessoa." };

  try {
    await updateUser(getDb(), {
      actorId: actor.id,
      userId: userId.data,
      fullName,
      role: role.data,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/usuarios");
  revalidatePath(`/admin/usuarios/${userId.data}`);
  return { success: "Dados do usuário salvos." };
}

// ---------------------------------------------------------------------------
// Ativar / desativar acesso
// ---------------------------------------------------------------------------

export async function setUserActiveAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireOwner("usuarios");

  const userId = z.uuid().safeParse(formData.get("userId"));
  const isActive = z
    .enum(["true", "false"])
    .safeParse(formData.get("isActive"));
  if (!userId.success || !isActive.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const activate = isActive.data === "true";
  try {
    await setUserActive(getDb(), usersDeps(), {
      actorId: actor.id,
      userId: userId.data,
      isActive: activate,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath("/admin/usuarios");
  revalidatePath(`/admin/usuarios/${userId.data}`);
  return {
    success: activate
      ? "Acesso ativado. A pessoa já consegue entrar."
      : "Acesso desativado. A pessoa é bloqueada no próximo clique.",
  };
}

// ---------------------------------------------------------------------------
// Redefinir senha (pelo proprietário)
// ---------------------------------------------------------------------------

export async function resetUserAccessAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireOwner("usuarios");

  const userId = z.uuid().safeParse(formData.get("userId"));
  if (!userId.success) {
    return { error: "Algo deu errado, tente novamente." };
  }

  const mode = resetModeSchema.safeParse(formData.get("mode"));
  if (!mode.success) {
    return { error: "Escolha como a pessoa vai receber a nova senha." };
  }

  const sendEmail = mode.data === "link" && isEmailConfigured();

  let result: Awaited<ReturnType<typeof resetUserPassword>>;
  try {
    result = await resetUserPassword(getDb(), usersDeps(), {
      actorId: actor.id,
      userId: userId.data,
      mode: mode.data,
      sendEmail,
    });
  } catch (error) {
    return toErrorState(error);
  }

  revalidatePath(`/admin/usuarios/${userId.data}`);

  return {
    success: "Acesso redefinido.",
    access: {
      kind: result.mode === "link" ? "link" : "password",
      userId: result.user.id,
      personName: result.user.fullName ?? result.user.email,
      email: result.user.email,
      accessUrl: result.accessUrl,
      temporaryPassword: result.temporaryPassword,
      emailAttempted: sendEmail,
      emailSent: result.emailSent,
      adopted: false,
    },
  };
}
