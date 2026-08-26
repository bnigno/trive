"use client";

import { cx } from "@/components/ui/cx";
import { formatTimeSP } from "./chat-format";
import { MessageTicks } from "./ticks";
import type { ChatMessage } from "./use-chat-poll";

// Rótulo de quem falou pela loja, mostrado uma vez por grupo de bolhas.
const ORIGIN_LABELS: Record<string, string> = {
  bot: "Robô",
  manual: "Você",
  auto: "Automática",
};

export function MessageBubble({
  message,
  firstOfGroup,
  onRetry,
  onImageLoad,
}: {
  message: ChatMessage;
  firstOfGroup: boolean;
  /** Presente só na bolha otimista que falhou: reenvia a mensagem. */
  onRetry?: () => void;
  onImageLoad?: () => void;
}) {
  const outbound = message.direction === "outbound";
  const originLabel =
    outbound && firstOfGroup ? (ORIGIN_LABELS[message.origin] ?? null) : null;

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
          "relative max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm sm:max-w-[70%]",
          outbound
            ? "bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]"
            : "bg-white text-[#111b21] dark:bg-[#202c33] dark:text-[#e9edef]",
          firstOfGroup &&
            (outbound ? "wa-tail-out rounded-tr-none" : "wa-tail-in rounded-tl-none"),
        )}
      >
        {originLabel ? (
          <p className="text-[11px] font-semibold text-[#008069] dark:text-[#06cf9c]">
            {originLabel}
          </p>
        ) : null}
        {message.kind === "image" && message.mediaUrl ? (
          <img
            src={message.mediaUrl}
            alt="Imagem enviada na conversa"
            onLoad={onImageLoad}
            className="mb-1 mt-0.5 max-h-64 rounded-md"
          />
        ) : null}
        {message.kind === "option_list" ? (
          <p className="text-[11px] font-medium text-[#667781] dark:text-[#8696a0]">
            📋 Menu interativo
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] leading-none text-[#667781] dark:text-[#8696a0]">
          <span>{formatTimeSP(message.createdAt)}</span>
          {outbound ? <MessageTicks status={message.status} /> : null}
        </p>
        {outbound && message.status === "failed" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-red-600 dark:text-red-400">
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
