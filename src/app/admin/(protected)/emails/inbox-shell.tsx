"use client";

// Casca client da caixa de e-mail. A seleção e a caixa vivem na URL
// (?c=<uuid>&ver=arquivadas) e o useSearchParams é a fonte da verdade: a
// navegação usa History API nativa (replaceState no desktop, pushState no
// mobile), que o App Router sincroniza.
//
// Sem som e sem notificação do sistema, ao contrário do chat: e-mail não é
// atendimento ao vivo, e o `useNotify` do WhatsApp levaria o clique do aviso
// para a tela de conversas. Aqui bastam o título da aba, o crachá do menu e
// o aviso para leitor de tela.
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "@/components/ui/cx";
import { markEmailThreadSeenAction, sendEmailReplyAction } from "./actions";
import { countAwaitingThreads, senderLabel } from "./email-format";
import { ThreadList } from "./thread-list";
import { ThreadPanel } from "./thread-panel";
import type { OptimisticDisplay } from "./message-list";
import {
  useInboxPoll,
  type InboxBox,
  type InboxMessage,
  type InboxPollResponse,
  type InboxThread,
  type InboxThreadItem,
} from "./use-inbox-poll";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_TIMEOUT_MS = 30_000;
// Folga de relógio entre navegador e banco ao casar a resposta otimista com a
// mensagem real (created_at do servidor pode ficar "antes" do clique local).
const CLOCK_SKEW_MS = 30_000;

interface OptimisticReply {
  tempId: string;
  threadId: string;
  body: string;
  createdAt: string;
  status: "queued" | "failed";
  error: string | null;
}

function urlFor(box: InboxBox, threadId: string | null): string {
  const params = new URLSearchParams();
  if (threadId) params.set("c", threadId);
  if (box === "archived") params.set("ver", "arquivadas");
  const query = params.toString();
  return query ? `/admin/emails?${query}` : "/admin/emails";
}

export interface InboxShellProps {
  initialThreads: InboxThreadItem[];
  initialThread: InboxThread | null;
  initialThreadItem: InboxThreadItem | null;
  initialSelectedId: string | null;
}

export function InboxShell({
  initialThreads,
  initialThread,
  initialThreadItem,
  initialSelectedId,
}: InboxShellProps) {
  const searchParams = useSearchParams();
  const rawSelected = searchParams.get("c");
  const selectedId =
    rawSelected && UUID_RE.test(rawSelected) ? rawSelected : null;
  const box: InboxBox =
    searchParams.get("ver") === "arquivadas" ? "archived" : "open";

  const [threads, setThreads] = useState(initialThreads);
  const [threadStatus, setThreadStatus] = useState(
    initialThread?.thread.status ?? null,
  );
  const [threadLoaded, setThreadLoaded] = useState(initialThread !== null);
  const [threadMissing, setThreadMissing] = useState(false);
  const [messagesMap, setMessagesMap] = useState<Map<string, InboxMessage>>(
    () => new Map((initialThread?.messages ?? []).map((m) => [m.id, m])),
  );
  const [optimistic, setOptimistic] = useState<OptimisticReply[]>([]);
  const [pollFailures, setPollFailures] = useState(0);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  // O servidor conta as pendentes olhando a caixa de entrada inteira, mesmo
  // com o arquivo aberto na tela; o valor local só segura o título da aba até
  // o primeiro poll chegar.
  const [awaitingCount, setAwaitingCount] = useState(() =>
    countAwaitingThreads(initialThreads),
  );
  // Última versão conhecida da conversa aberta (ver handlePollResult).
  const [stickyItem, setStickyItem] = useState(initialThreadItem);

  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const boxRef = useRef(box);
  useEffect(() => {
    boxRef.current = box;
  }, [box]);

  // Espelhos para os callbacks assíncronos lerem o valor atual sem depender
  // do ciclo de render.
  const messagesMapRef = useRef(messagesMap);
  const optimisticRef = useRef(optimistic);
  useEffect(() => {
    optimisticRef.current = optimistic;
  }, [optimistic]);

  const pendingSeenRef = useRef(false);
  const sendTimersRef = useRef(new Map<string, number>());
  const baseTitleRef = useRef<string | null>(null);
  const announceSeqRef = useRef(0);

  const announce = useCallback((text: string) => {
    // aria-live só re-anuncia quando o conteúdo muda: alterna um NBSP no fim
    // para o mesmo aviso repetido ser lido de novo.
    announceSeqRef.current += 1;
    setAnnouncement(announceSeqRef.current % 2 === 0 ? `${text}\u00A0` : text);
  }, []);

  const markSeen = useCallback((threadId: string) => {
    void markEmailThreadSeenAction(threadId)
      .then((result) => {
        if (!result.ok) return;
        setThreads((prev) =>
          prev.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t)),
        );
      })
      .catch(() => {
        // "Visto" é telemetria: falhar não pode atrapalhar o atendimento.
      });
  }, []);

  const handlePollResult = useCallback(
    (data: InboxPollResponse, requestedId: string | null) => {
      setPollFailures(0);
      setThreads(data.threads);
      setAwaitingCount(data.awaitingCount);

      if (requestedId === null) return;

      // Enquanto a conversa aberta aparecer na lista, guardamos a última
      // versão dela: arquivar tira a linha da lista, e sem esta cópia o
      // cabeçalho perderia assunto e remetente na mesma hora.
      const listed = data.threads.find((t) => t.id === requestedId);
      if (listed) setStickyItem(listed);

      const incoming = data.thread;
      if (incoming === null) {
        setThreadMissing(true);
        setThreadLoaded(true);
        setThreadStatus(null);
        return;
      }
      setThreadMissing(false);
      setThreadLoaded(true);
      setThreadStatus(incoming.thread.status);

      const prevMap = messagesMapRef.current;
      const newInbound = incoming.messages.filter(
        (m) => m.direction === "inbound" && !prevMap.has(m.id),
      );
      const nextMap = new Map(prevMap);
      for (const m of incoming.messages) nextMap.set(m.id, m);
      messagesMapRef.current = nextMap;
      setMessagesMap(nextMap);

      // Reconciliação do envio otimista: mensagem real de saída, mesmo texto,
      // criada depois do clique (com folga de relógio). Cada mensagem real
      // consome no máximo um cartão otimista.
      const sent = incoming.messages.filter((m) => m.direction === "outbound");
      if (sent.length > 0 && optimisticRef.current.length > 0) {
        setOptimistic((prevOpt) => {
          const available = [...sent];
          return prevOpt.filter((o) => {
            if (o.threadId !== requestedId) return true;
            const index = available.findIndex(
              (m) =>
                m.textBody === o.body &&
                Date.parse(m.createdAt) >=
                  Date.parse(o.createdAt) - CLOCK_SKEW_MS,
            );
            if (index === -1) return true;
            available.splice(index, 1);
            const timer = sendTimersRef.current.get(o.tempId);
            if (timer !== undefined) {
              window.clearTimeout(timer);
              sendTimersRef.current.delete(o.tempId);
            }
            return false;
          });
        });
      }

      if (newInbound.length > 0) {
        const item = data.threads.find((t) => t.id === requestedId) ?? null;
        const who = item
          ? senderLabel(item)
          : (newInbound[newInbound.length - 1]?.fromAddress ?? "cliente");
        announce(`Novo e-mail de ${who}`);
        if (document.hidden) {
          pendingSeenRef.current = true;
        } else {
          // Gatilho 2 do "visto": e-mail novo com a conversa aberta e visível.
          markSeen(requestedId);
        }
      }
    },
    [announce, markSeen],
  );

  const handlePollFailure = useCallback(() => {
    setPollFailures((count) => count + 1);
  }, []);

  const { pollNow } = useInboxPoll({
    selectedId,
    box,
    onResult: handlePollResult,
    onFailure: handlePollFailure,
  });

  // Troca de conversa: zera a anterior (o poll imediato do hook traz a nova
  // cauda). O estado semeado pelo servidor só vale para a seleção inicial.
  const prevSelectedRef = useRef(initialSelectedId);
  useEffect(() => {
    if (prevSelectedRef.current === selectedId) return;
    prevSelectedRef.current = selectedId;
    messagesMapRef.current = new Map();
    setMessagesMap(new Map());
    setThreadStatus(null);
    setThreadLoaded(false);
    setThreadMissing(false);
    setStickyItem(null);
    pendingSeenRef.current = false;
  }, [selectedId]);

  // Gatilho 1 do "visto": conversa aberta com a aba visível.
  useEffect(() => {
    if (!selectedId) return;
    if (document.hidden) {
      pendingSeenRef.current = true;
      return;
    }
    markSeen(selectedId);
  }, [selectedId, markSeen]);

  // Gatilho 3 do "visto": aba voltou a ficar visível com pendência.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden || !pendingSeenRef.current) return;
      pendingSeenRef.current = false;
      const id = selectedIdRef.current;
      if (id) markSeen(id);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [markSeen]);

  // Título da aba: "(N) E-mails" com as conversas aguardando; restaura ao sair.
  useEffect(() => {
    baseTitleRef.current ??= document.title;
    const base = baseTitleRef.current;
    document.title = awaitingCount > 0 ? `(${awaitingCount}) E-mails` : base;
    return () => {
      document.title = base;
    };
  }, [awaitingCount]);

  // Limpeza dos timeouts de envio pendentes ao desmontar.
  useEffect(() => {
    const timers = sendTimersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  const listItem = useMemo(
    () => threads.find((t) => t.id === selectedId) ?? null,
    [threads, selectedId],
  );
  const openItem =
    listItem ?? (stickyItem?.id === selectedId ? stickyItem : null);

  const failOptimistic = useCallback((tempId: string, error: string) => {
    const timer = sendTimersRef.current.get(tempId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      sendTimersRef.current.delete(tempId);
    }
    setOptimistic((prev) =>
      prev.map((o) =>
        o.tempId === tempId && o.status === "queued"
          ? { ...o, status: "failed" as const, error }
          : o,
      ),
    );
  }, []);

  const scheduleSendTimeout = useCallback(
    (tempId: string) => {
      const timer = window.setTimeout(() => {
        failOptimistic(
          tempId,
          "Não foi possível confirmar o envio. Verifique a conexão.",
        );
      }, SEND_TIMEOUT_MS);
      sendTimersRef.current.set(tempId, timer);
    },
    [failOptimistic],
  );

  const submitSend = useCallback(
    (tempId: string, threadId: string, body: string) => {
      void sendEmailReplyAction(threadId, body)
        .then((result) => {
          if ("error" in result) {
            failOptimistic(tempId, result.error);
            return;
          }
          // A confirmação visual vem do poll (o cartão real substitui o
          // otimista); poll imediato para não esperar o ciclo inteiro.
          pollNow();
        })
        .catch(() => failOptimistic(tempId, "Falha ao enviar. Tente de novo."));
    },
    [failOptimistic, pollNow],
  );

  const handleSend = useCallback(
    (body: string) => {
      const threadId = selectedIdRef.current;
      if (!threadId) return;
      const tempId =
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setOptimistic((prev) => [
        ...prev,
        {
          tempId,
          threadId,
          body,
          createdAt: new Date().toISOString(),
          status: "queued" as const,
          error: null,
        },
      ]);
      setScrollSignal((n) => n + 1);
      scheduleSendTimeout(tempId);
      submitSend(tempId, threadId, body);
    },
    [scheduleSendTimeout, submitSend],
  );

  const handleRetry = useCallback(
    (tempId: string) => {
      const target = optimisticRef.current.find((o) => o.tempId === tempId);
      if (!target || target.status !== "failed") return;
      const createdAt = new Date().toISOString();
      setOptimistic((prev) =>
        prev.map((o) =>
          o.tempId === tempId
            ? { ...o, status: "queued" as const, error: null, createdAt }
            : o,
        ),
      );
      setScrollSignal((n) => n + 1);
      scheduleSendTimeout(tempId);
      submitSend(tempId, target.threadId, target.body);
    },
    [scheduleSendTimeout, submitSend],
  );

  const handleSelect = useCallback((id: string) => {
    if (id === selectedIdRef.current) return;
    // replaceState no desktop (a lista segue visível, não polui o histórico);
    // pushState no mobile para o botão de voltar fechar a conversa.
    const url = urlFor(boxRef.current, id);
    if (window.matchMedia("(min-width: 768px)").matches) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }
  }, []);

  const handleBack = useCallback(() => {
    const before = window.location.search;
    window.history.back();
    // Link direto (favorito, aviso): sem entrada anterior o back não muda a
    // URL — cai no fallback e limpa o ?c= trocando o estado atual.
    window.setTimeout(() => {
      if (window.location.search === before) {
        window.history.replaceState(null, "", urlFor(boxRef.current, null));
      }
    }, 250);
  }, []);

  // Trocar de caixa é mudança de tela, não de seleção: pushState para o botão
  // de voltar desfazer. A conversa aberta sai da URL — ela é de outra caixa.
  const handleBoxChange = useCallback((next: InboxBox) => {
    if (next === boxRef.current) return;
    window.history.pushState(null, "", urlFor(next, null));
  }, []);

  const sortedMessages = useMemo(() => {
    const arr = Array.from(messagesMap.values());
    // Mesma ordem do servidor: (created_at, id) — ISO 8601 compara certo como
    // string e o id desempata mensagens nascidas na mesma transação.
    arr.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return arr;
  }, [messagesMap]);

  const optimisticForSelected = useMemo<OptimisticDisplay[]>(
    () =>
      optimistic
        .filter((o) => o.threadId === selectedId)
        .map(({ tempId, body, createdAt, status, error }) => ({
          tempId,
          body,
          createdAt,
          status,
          error,
        })),
    [optimistic, selectedId],
  );

  const status = threadStatus ?? openItem?.status ?? "open";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {pollFailures >= 2 ? (
        <div
          role="status"
          className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
        >
          Reconectando…
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 md:grid-cols-[380px_1fr]">
        <section
          aria-label="Lista de e-mails"
          className={cx(
            "min-h-0 min-w-0 flex-col border-zinc-200 md:border-r dark:border-zinc-800",
            selectedId ? "hidden md:flex" : "flex",
          )}
        >
          <ThreadList
            threads={threads}
            selectedId={selectedId}
            box={box}
            onSelect={handleSelect}
            onBoxChange={handleBoxChange}
          />
        </section>
        <section
          aria-label="E-mail aberto"
          className={cx(
            "min-h-0 min-w-0 flex-col",
            selectedId ? "flex" : "hidden md:flex",
          )}
        >
          <ThreadPanel
            selectedId={selectedId}
            subject={openItem?.subject ?? ""}
            participantEmail={openItem?.participantEmail ?? ""}
            participantName={openItem?.participantName ?? null}
            customerName={openItem?.customerName ?? null}
            status={status}
            loaded={threadLoaded}
            missing={threadMissing}
            messages={sortedMessages}
            optimistic={optimisticForSelected}
            scrollSignal={scrollSignal}
            onSend={handleSend}
            onRetry={handleRetry}
            onBack={handleBack}
            pollNow={pollNow}
          />
        </section>
      </div>
    </div>
  );
}
