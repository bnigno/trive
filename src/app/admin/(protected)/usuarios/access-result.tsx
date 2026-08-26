"use client";

import { CopyField } from "@/components/ui/copy-field";
import type { AccessResultData } from "./actions";

/**
 * Mostra o acesso recém-gerado (link de convite/recuperação ou senha
 * provisória) para o dono copiar e entregar pelo canal que ele quiser.
 *
 * Este é o ÚNICO lugar onde esse valor aparece: ele não é gravado no banco
 * nem registrado no histórico, então quem fechar a tela sem copiar precisa
 * gerar outro em "Redefinir senha".
 */
export function AccessResult({ data }: { data: AccessResultData }) {
  const isLink = data.kind === "link";
  const value = isLink ? data.accessUrl : data.temporaryPassword;

  if (!value) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        O acesso foi salvo, mas o link/senha não voltou para a tela. Use
        “Redefinir senha” na página da pessoa para gerar outro.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/50">
      <div>
        <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
          {isLink
            ? `Link de acesso de ${data.personName}`
            : `Senha provisória de ${data.personName}`}
        </p>
        <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">
          Mostramos isto uma única vez. Copie agora e mande para{" "}
          <span className="font-medium">{data.email}</span> pelo canal que você
          já usa (WhatsApp, por exemplo).
        </p>
      </div>

      <CopyField
        label={isLink ? "Link de acesso" : "Senha provisória"}
        value={value}
        hint={
          isLink
            ? "O link vale por tempo limitado e só pode ser usado uma vez. Se expirar, gere outro em “Redefinir senha”."
            : "A pessoa entra com o e-mail e esta senha, e pode trocá-la depois em “Minha senha”."
        }
      />

      {data.emailAttempted ? (
        <p
          role="status"
          className={
            data.emailSent
              ? "text-xs text-emerald-800 dark:text-emerald-300"
              : "text-xs text-amber-800 dark:text-amber-300"
          }
        >
          {data.emailSent
            ? `Também enviamos por e-mail para ${data.email}.`
            : "Não consegui enviar o e-mail agora — entregue o link pelo WhatsApp mesmo."}
        </p>
      ) : null}

      {data.adopted ? (
        <p className="text-xs text-emerald-800 dark:text-emerald-300">
          Esta pessoa já tinha uma conta de acesso com este e-mail e ela foi
          reaproveitada — nada foi duplicado.
        </p>
      ) : null}
    </div>
  );
}
