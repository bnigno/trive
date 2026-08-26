"use client";

import { formatAttachmentSize } from "./email-format";
import type { InboxAttachment } from "./use-inbox-poll";

function ClipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path
        d="M18 8.5l-7.1 7.1a2.7 2.7 0 1 1-3.8-3.8l7.7-7.7a4 4 0 1 1 5.7 5.7l-7.8 7.8a5.4 5.4 0 1 1-7.6-7.6L12 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AttachmentList({
  attachments,
}: {
  attachments: InboxAttachment[];
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {attachments.length === 1
          ? "1 arquivo em anexo"
          : `${attachments.length} arquivos em anexo`}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {attachments.map((attachment, index) => (
          // O nome do arquivo não é único dentro da mensagem (dois anexos
          // podem se chamar "foto.jpg"): o índice entra na chave.
          <li key={`${index}-${attachment.filename}`}>
            {attachment.url ? (
              <a
                href={attachment.url}
                // O arquivo mora em outro domínio (storage), onde o atributo
                // `download` não vale: abre em aba nova e o navegador decide
                // entre mostrar e baixar. `noreferrer` não vaza a URL do painel.
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-50 motion-reduce:transition-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
                  <ClipIcon />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {attachment.filename}
                </span>
                <span className="shrink-0 text-zinc-500 dark:text-zinc-400">
                  {formatAttachmentSize(attachment.sizeBytes)}
                </span>
              </a>
            ) : (
              <span className="flex items-center gap-2 rounded-md border border-dashed border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                <span className="shrink-0">
                  <ClipIcon />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {attachment.filename}
                </span>
                <span className="shrink-0">arquivo indisponível</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
