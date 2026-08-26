"use client";

import { useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { AttachmentList } from "./attachment-list";
import {
  messageTimestamp,
  senderInitials,
  subjectChanged,
  subjectOrPlaceholder,
} from "./email-format";
import type { InboxMessage } from "./use-inbox-poll";

const STATUS_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  queued: { label: "Na fila", tone: "warning" },
  sent: { label: "Enviado", tone: "success" },
  failed: { label: "Falhou", tone: "danger" },
};

/**
 * O HTML do e-mail é conteúdo HOSTIL por definição: quem escreveu está fora da
 * loja e pode mandar o que quiser. Por isso ele nunca entra no DOM do painel
 * (nada de dangerouslySetInnerHTML, que executaria <script>, <img onerror> e
 * companhia com a sessão do dono aberta). Ele vai para dentro de um <iframe>
 * com sandbox VAZIO: sem scripts, sem acesso ao painel (opaque origin), sem
 * abrir janela e sem navegar a aba.
 *
 * O CSP aqui é o cinto além do suspensório: mesmo que um dia alguém afrouxe o
 * sandbox, continua sem script, sem iframe aninhado e sem formulário. Imagens
 * ficam liberadas de propósito — sem elas quase todo e-mail de empresa fica
 * ilegível —, e é por isso que o rodapé avisa sobre o rastreio de abertura.
 */
function sandboxedDocument(html: string): string {
  const policy =
    "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src data:";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>body{margin:0;padding:12px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#18181b;background:#fff;overflow-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${html}</body></html>`;
}

export function MessageCard({
  message,
  senderName,
  threadSubject,
  onRetry,
}: {
  message: InboxMessage;
  /** Como chamar quem escreveu — calculado uma vez pela lista. */
  senderName: string;
  /** Assunto da conversa: o cartão só mostra o dele quando os dois diferem. */
  threadSubject: string;
  /** Presente só no cartão otimista que falhou: reenvia a resposta. */
  onRetry?: () => void;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const outbound = message.direction === "outbound";
  const who = outbound ? "Você" : senderName;
  const statusBadge = outbound ? STATUS_LABELS[message.status] : undefined;
  const hasHtml = message.htmlBody !== null && message.htmlBody.trim() !== "";
  const bodyText = message.textBody.trim();

  return (
    <article
      className={cx(
        "rounded-lg border px-3 py-2.5 shadow-sm md:px-4 md:py-3",
        outbound
          ? "border-indigo-200 bg-indigo-50/60 dark:border-indigo-900 dark:bg-indigo-950/30"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
      )}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className={cx(
            "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
            outbound
              ? "bg-indigo-600 text-white"
              : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
          )}
        >
          {senderInitials(who)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {who}
          </p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {outbound
              ? `para ${message.toAddresses.join(", ") || "—"}`
              : message.fromAddress}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {messageTimestamp(message.createdAt)}
          </span>
          {statusBadge ? (
            <Badge tone={statusBadge.tone}>{statusBadge.label}</Badge>
          ) : null}
        </div>
      </header>

      {subjectChanged(message.subject, threadSubject) ? (
        <p className="mt-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <span className="mr-1 text-[11px] font-normal uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Assunto desta mensagem:
          </span>
          {subjectOrPlaceholder(message.subject)}
        </p>
      ) : null}

      <p className="mt-2.5 whitespace-pre-wrap break-words text-sm text-zinc-800 dark:text-zinc-200">
        {bodyText === "" ? "(mensagem sem texto)" : bodyText}
      </p>

      {hasHtml ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowOriginal((value) => !value)}
            aria-expanded={showOriginal}
            className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-100 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {showOriginal ? "Esconder o original" : "Ver original"}
          </button>
          {showOriginal ? (
            <div className="mt-2">
              <iframe
                // sandbox="" (vazio) é o ponto principal: nenhuma permissão.
                // Trocar por "allow-scripts allow-same-origin" daria ao e-mail
                // de um estranho acesso à sessão do painel.
                sandbox=""
                referrerPolicy="no-referrer"
                loading="lazy"
                title="E-mail original, sem programas em execução"
                srcDoc={sandboxedDocument(message.htmlBody ?? "")}
                className="h-96 w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-700"
              />
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                Mostrando o e-mail como ele foi montado por quem enviou. Links e
                botões aqui dentro não funcionam, de propósito. As imagens são
                carregadas do servidor do remetente, então ele pode descobrir
                que você abriu a mensagem.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <AttachmentList attachments={message.attachments} />

      {outbound && message.status === "failed" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-red-600 dark:text-red-400">
          <span>{message.errorDetail ?? "Não foi possível enviar."}</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="font-medium underline"
            >
              Tentar de novo
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
