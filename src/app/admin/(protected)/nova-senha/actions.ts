"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/services/auth";
import { recordPasswordChanged } from "@/services/users";

export type FormState = { error?: string; success?: string };

const MIN_LENGTH = 8;

const passwordSchema = z
  .object({
    password: z
      .string()
      .min(MIN_LENGTH, `A senha precisa ter pelo menos ${MIN_LENGTH} caracteres.`),
    confirmation: z.string(),
  })
  .refine((value) => value.password === value.confirmation, {
    message: "As duas senhas não são iguais. Digite de novo.",
    path: ["confirmation"],
  });

/** Traduz o que o provedor recusa; o resto vira mensagem genérica. */
function translateAuthError(message: string): string {
  if (message.includes("different from the old password")) {
    return "A nova senha precisa ser diferente da senha atual.";
  }
  if (message.includes("weak") || message.includes("Password should be")) {
    return "Escolha uma senha mais forte: use pelo menos 8 caracteres, misturando letras e números.";
  }
  if (message.includes("rate limit") || message.includes("Too many")) {
    return "Muitas tentativas seguidas. Aguarde um instante e tente de novo.";
  }
  return "Não foi possível salvar a nova senha. Tente de novo em alguns instantes.";
}

export async function setMyPasswordAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const parsed = passwordSchema.safeParse({
    password: formData.get("password"),
    confirmation: formData.get("confirmation"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Confira os campos e tente de novo.",
    };
  }

  // Senha igual ao e-mail é a primeira coisa que qualquer invasor tenta.
  if (parsed.data.password.trim().toLowerCase() === user.email.toLowerCase()) {
    return { error: "Escolha uma senha diferente do seu e-mail." };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.updateUser({
      password: parsed.data.password,
    });
    if (error) return { error: translateAuthError(error.message) };

    // A senha JÁ mudou neste ponto. Falha ao registrar o histórico não pode
    // virar erro na tela (seria mentira) — só custa o carimbo que tira a
    // conta de "convite pendente" na lista de usuários.
    try {
      await recordPasswordChanged(getDb(), { userId: user.id });
    } catch (auditError) {
      console.warn("[nova-senha] falha ao registrar troca de senha:", auditError);
    }

    // Sai de todas as sessões (o signOut do Supabase é global): se alguém
    // tinha entrado com a senha antiga, perde o acesso agora.
    await supabase.auth.signOut();
  } catch (error) {
    console.error("[nova-senha] erro inesperado ao salvar a senha:", error);
    return {
      error: "Não foi possível salvar a nova senha. Tente de novo em alguns instantes.",
    };
  }

  redirect("/admin/login?motivo=senha-alterada");
}
