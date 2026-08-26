"use client";

// Poll do chat: setTimeout encadeado de 3s enquanto a aba está visível,
// pausa total quando oculta (com poll imediato ao voltar) e backoff
// 3→6→12→30s em erro. A resposta é validada com Zod (parse, não cast) e
// descartada se a conversa aberta mudou enquanto a requisição voava.
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod";

const POLL_URL = "/admin/whatsapp/conversas/poll";
const DELAYS_MS = [3_000, 6_000, 12_000, 30_000] as const;

const chatMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  origin: z.enum(["customer", "bot", "manual", "auto"]),
  kind: z.string(),
  body: z.string(),
  mediaUrl: z.string().nullable(),
  status: z.string(),
  errorDetail: z.string().nullable(),
  createdAt: z.string(),
});

const chatConversationSchema = z.object({
  id: z.string(),
  phoneE164: z.string(),
  customerName: z.string().nullable(),
  status: z.string(),
  botDisabledUntil: z.string().nullable(),
  lastMessageAt: z.string().nullable(),
  lastMessageDirection: z.enum(["inbound", "outbound"]).nullable(),
  lastMessagePreview: z.string().nullable(),
  unreadCount: z.number(),
});

const chatThreadSchema = z.object({
  conversation: z.object({
    id: z.string(),
    status: z.string(),
    botDisabledUntil: z.string().nullable(),
    ownerLastSeenAt: z.string().nullable(),
  }),
  messages: z.array(chatMessageSchema),
});

const pollResponseSchema = z.object({
  serverTime: z.string(),
  humanCount: z.number(),
  conversations: z.array(chatConversationSchema),
  thread: chatThreadSchema.nullable(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatConversation = z.infer<typeof chatConversationSchema>;
export type ChatThread = z.infer<typeof chatThreadSchema>;
export type ChatPollResponse = z.infer<typeof pollResponseSchema>;

export function useChatPoll({
  selectedId,
  onResult,
  onFailure,
}: {
  selectedId: string | null;
  onResult: (data: ChatPollResponse, requestedId: string | null) => void;
  onFailure: () => void;
}): { pollNow: () => void } {
  const selectedIdRef = useRef(selectedId);
  const onResultRef = useRef(onResult);
  const onFailureRef = useRef(onFailure);
  const pollNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    onResultRef.current = onResult;
    onFailureRef.current = onFailure;
  }, [onResult, onFailure]);

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
      const url = requestedId ? `${POLL_URL}?c=${requestedId}` : POLL_URL;
      try {
        const res = await fetch(url, {
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
        // A conversa aberta mudou durante o voo: resposta velha, descarta.
        if (requestedId === selectedIdRef.current) {
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
    // O primeiro poll fica para daqui a 3s: o RSC acabou de entregar os dados.
    schedule(delay());

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  // Troca de conversa: atualiza a referência ANTES de disparar o poll
  // imediato, para a requisição já sair com o novo `?c=`.
  const isFirstSelectionRef = useRef(true);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (isFirstSelectionRef.current) {
      isFirstSelectionRef.current = false;
      return;
    }
    pollNowRef.current();
  }, [selectedId]);

  const pollNow = useCallback(() => {
    pollNowRef.current();
  }, []);

  return { pollNow };
}
