"use server";

import { z } from "zod";

import { getEmailProvider, isEmailConfigured } from "@/adapters/email";
import { getIdentityProvider } from "@/adapters/identity";
import { getDb } from "@/db/client";
import { requestPasswordReset } from "@/services/users";

export type FormState = { error?: string; success?: string };

/**
 * Resposta ÚNICA do caminho feliz. Ela é dita igual para e-mail cadastrado,
 * e-mail que não existe, acesso desativado e pedido repetido demais: qualquer
 * diferença aqui transformaria esta tela pública numa lista de quem tem conta
 * no painel.
 */
const GENERIC_RESULT =
  "Se este e-mail estiver cadastrado, enviamos um link de acesso. " +
  "Confira também o lixo eletrônico.";

/**
 * Canal de e-mail desligado é condição da LOJA inteira, não de uma pessoa:
 * dizer isso com todas as letras não entrega ninguém, e calar seria pior —
 * a pessoa ficaria esperando para sempre um e-mail que nunca sai.
 */
const EMAIL_OFF =
  "O envio de e-mails ainda não está ligado nesta loja. Fale com o " +
  "responsável pelo painel — ele consegue gerar um link de acesso para você " +
  "na hora.";

const SEND_FAILED =
  "Não conseguimos enviar o e-mail agora. Tente de novo em alguns minutos.";

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Informe um e-mail válido."));

/**
 * Pedido de recuperação de senha, feito por quem NÃO está logado. Por isso
 * esta é a única action do painel sem guard de sessão — quem esqueceu a senha
 * não tem como provar quem é antes de receber o link.
 */
export async function requestPasswordResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formData.get("email");
  const parsed = emailSchema.safeParse(typeof raw === "string" ? raw : "");
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Informe um e-mail válido." };
  }

  try {
    const result = await requestPasswordReset(
      getDb(),
      {
        identity: getIdentityProvider(),
        // null = sem canal de e-mail; o service devolve o status honesto em
        // vez de fingir que mandou.
        email: isEmailConfigured() ? getEmailProvider() : null,
      },
      { email: parsed.data },
    );

    if (result.status === "email_nao_configurado") return { error: EMAIL_OFF };
  } catch (error) {
    // Falha de verdade (provedor fora do ar, banco indisponível). O service já
    // engoliu sozinho tudo que revelaria a existência da conta, então o que
    // chega aqui pode ser reportado sem risco de enumeração.
    console.error("[esqueci-senha] falha ao pedir recuperação:", error);
    return { error: SEND_FAILED };
  }

  return { success: GENERIC_RESULT };
}
