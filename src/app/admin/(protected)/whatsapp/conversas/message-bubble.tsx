"use client";

import { cx } from "@/components/ui/cx";
import { formatTimeSP } from "./chat-format";
import { MessageTicks } from "./ticks";
import type { ChatMessage } from "./use-chat-poll";

export function MessageBubble({
  message,
  firstOfGroup,
  sellerName,
  onRetry,
  onImageLoad,
}: {
  message: ChatMessage;
  firstOfGroup: boolean;
  sellerName: string;
  /** Presente só na bolha otimista que falhou: reenvia a mensagem. */
  onRetry?: () => void;
  onImageLoad?: () => void;
}) {
  const outbound = message.direction === "outbound";
  // Rótulo de quem falou pela loja, mostrado uma vez por grupo de bolhas.
  const originLabel =
    outbound && firstOfGroup
      ? message.origin === "bot"
        ? sellerName
        : message.origin === "manual"
          ? "Você"
          : "Automática"
      : null;

  return (
    <div
      className={cx(
        "flex",
        outbound ? "justify-end" : "justify-start",
        firstOfGroup ? "mt-2.5" : "mt-0.5",
      )}
    >
      {/* `relative` é exigido pelos rabinhos .wa-tail-* (globals.css). As
          cores da bolha estão espelhadas lá — mudou aqui, mude lá junto. */}
      <div
        className={cx(
          "relative max-w-[85%] rounded-xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[70%]",
          outbound
            ? "bg-ink-900 text-ivory-50 dark:bg-ivory-100 dark:text-ink-900"
            : "border border-ivory-300 bg-white text-ink-900 dark:border-ink-700 dark:bg-ink-800 dark:text-ivory-100",
          firstOfGroup &&
            (outbound ? "wa-tail-out rounded-tr-none" : "wa-tail-in rounded-tl-none"),
        )}
      >
        {originLabel ? (
          <p
            className={cx(
              "text-[11px] font-semibold tracking-wide",
              message.origin === "bot"
                ? "text-gold-400 dark:text-gold-700"
                : "text-ivory-300 dark:text-ink-500",
            )}
          >
            {originLabel}
          </p>
        ) : null}
        {message.kind === "image" && message.mediaUrl ? (
          <a href={message.mediaUrl} target="_blank" rel="noreferrer">
            <img
              src={message.mediaUrl}
              alt="Imagem enviada na conversa"
              onLoad={onImageLoad}
              className="mb-1 mt-0.5 max-h-64 rounded-md"
            />
          </a>
        ) : null}
        {message.kind === "option_list" ? (
          <p
            className={cx(
              "text-[11px] font-medium",
              outbound ? "text-ivory-300 dark:text-ink-500" : "text-ink-400",
            )}
          >
            📋 Catálogo com botões
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <p
          className={cx(
            "mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none",
            outbound ? "text-ivory-300/80 dark:text-ink-500" : "text-ink-400",
          )}
        >
          <span>{formatTimeSP(message.createdAt)}</span>
          {outbound ? <MessageTicks status={message.status} /> : null}
        </p>
        {outbound && message.status === "failed" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-red-300 dark:text-red-600">
            <span>{message.errorDetail ?? "Falha no envio."}</span>
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
      </div>
    </div>
  );
}
