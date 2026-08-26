"use client";

// Poll da caixa de e-mail: setTimeout ENCADEADO (nunca setInterval — dois
// ciclos lentos se empilhariam), pausa total com a aba oculta, poll imediato
// ao voltar e backoff em erro. A resposta é validada com Zod (parse, não
// cast) e descartada se o dono trocou de conversa ou de caixa durante o voo.
//
// 15 segundos de base, contra os 3 do chat do WhatsApp, e o motivo é a
// origem: mensagem de WhatsApp chega por webhook no mesmo segundo, enquanto
// e-mail entra por uma leitura IMAP agendada (minutos entre uma e outra).
// Puxar de 3 em 3 segundos gastaria dezenas de consultas para cada novidade.
// 15s ainda é rápido para o que muda por ação do dono na tela — o "na fila"
// da resposta virando "enviado" —, e todo envio chama pollNow() na hora.
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";

const POLL_URL = "/admin/emails/poll";
const DELAYS_MS = [15_000, 30_000, 60_000, 120_000] as const;

const attachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  /** null quando o arquivo não tem link público (storage indisponível). */
  url: z.string().nullable(),
});

const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  fromAddress: z.string(),
  fromName: z.string().nullable(),
  toAddresses: z.array(z.string()),
  subject: z.string(),
  textBody: z.string(),
  htmlBody: z.string().nullable(),
  attachments: z.array(attachmentSchema),
  status: z.string(),
  errorDetail: z.string().nullable(),
  createdAt: z.string(),
});

const threadListItemSchema = z.object({
  id: z.string(),
  subject: z.string(),
  participantEmail: z.string(),
  participantName: z.string().nullable(),
  customerName: z.string().nullable(),
  status: z.string(),
  lastMessageAt: z.string().nullable(),
  lastMessageDirection: z.enum(["inbound", "outbound"]).nullable(),
  lastMessageSnippet: z.string().nullable(),
  unreadCount: z.number(),
});

const threadSchema = z.object({
  thread: z.object({
    id: z.string(),
    status: z.string(),
    ownerLastSeenAt: z.string().nullable(),
  }),
  messages: z.array(messageSchema),
});

const pollResponseSchema = z.object({
  serverTime: z.string(),
  awaitingCount: z.number(),
  box: z.enum(["open", "archived"]),
  threads: z.array(threadListItemSchema),
  thread: threadSchema.nullable(),
});

export type InboxAttachment = z.infer<typeof attachmentSchema>;
export type InboxMessage = z.infer<typeof messageSchema>;
export type InboxThreadItem = z.infer<typeof threadListItemSchema>;
export type InboxThread = z.infer<typeof threadSchema>;
export type InboxPollResponse = z.infer<typeof pollResponseSchema>;

/** Qual caixa está aberta: a de entrada ou o arquivo. */
export type InboxBox = "open" | "archived";

export function useInboxPoll({
  selectedId,
  box,
  onResult,
  onFailure,
}: {
  selectedId: string | null;
  box: InboxBox;
  onResult: (data: InboxPollResponse, requestedId: string | null) => void;
  onFailure: () => void;
}): { pollNow: () => void } {
  const selectedIdRef = useRef(selectedId);
  const boxRef = useRef(box);
  const onResultRef = useRef(onResult);
  const onFailureRef = useRef(onFailure);
  const pollNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    onResultRef.current = onResult;
    onFailureRef.current = onFailure;
  }, [onResult, onFailure]);

  // Deps [] de propósito: este efeito monta UM loop de poll para a vida toda
  // do componente. Reagir a `selectedId`/`box` aqui remontaria o loop (e
  // zeraria o backoff) a cada clique; quem avisa o loop são as refs acima.
  useEffect(() => {
    let failures = 0;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let disposed = false;

    const delay = () => DELAYS_MS[Math.min(failures, DELAYS_MS.length - 1)];

    const schedule = (ms: number) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void poll();
      }, ms);
    };

    const poll = async () => {
      if (disposed || document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      const requestedId = selectedIdRef.current;
      const requestedBox = boxRef.current;
      const params = new URLSearchParams();
      if (requestedId) params.set("c", requestedId);
      if (requestedBox === "archived") params.set("ver", "arquivadas");
      const query = params.toString();
      try {
        const res = await fetch(query ? `${POLL_URL}?${query}` : POLL_URL, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`poll ${res.status}`);
        const parsed = pollResponseSchema.safeParse(
          (await res.json()) as unknown,
        );
        if (!parsed.success) throw new Error("poll shape");
        if (disposed) return;
        failures = 0;
        // A tela mudou durante o voo: resposta velha, descarta em vez de
        // pintar a conversa errada por um instante.
        if (
          requestedId === selectedIdRef.current &&
          requestedBox === boxRef.current
        ) {
          onResultRef.current(parsed.data, requestedId);
        }
      } catch (error) {
        if (disposed) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        failures += 1;
        onFailureRef.current();
      }
      if (!disposed && !document.hidden) schedule(delay());
    };

    pollNowRef.current = () => {
      window.clearTimeout(timer);
      void poll();
    };

    const onVisibilityChange = () => {
      window.clearTimeout(timer);
      if (document.hidden) {
        controller?.abort();
      } else {
        void poll();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    // O primeiro poll fica para daqui a 15s: o servidor acabou de entregar
    // esta mesma tela renderizada.
    schedule(delay());

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Troca de conversa ou de caixa: atualiza as referências ANTES de disparar
  // o poll imediato, para a requisição já sair com os parâmetros novos.
  const isFirstRunRef = useRef(true);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    boxRef.current = box;
    if (isFirstRunRef.current) {
      isFirstRunRef.current = false;
      return;
    }
    pollNowRef.current();
  }, [selectedId, box]);

  const pollNow = useCallback(() => {
    pollNowRef.current();
  }, []);

  return { pollNow };
}
