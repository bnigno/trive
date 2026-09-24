"use client";
// As peças lado a lado: a foto inteira é o botão do voto. Depois do voto, o
// placar, o recado opcional (vai para a cliente pelo WhatsApp da loja, sem
// link nem telefone — o servidor tira) e o convite para falar com a vendedora.
import { useState, useSyncExternalStore, useTransition } from "react";

import { btnOutline, btnSmallDark, inputBase } from "@/components/store/styles";
import { getVoterId, readVotedChoice, subscribeVoted, votedSnapshot, writeVotedChoice } from "@/lib/friends-storage";

import { bridgeAction, noteAction, voteAction } from "@/app/(store)/v/[token]/actions";

type Option = { letter: string; name: string; detail: string | null; imageUrl: string | null; slug: string };

/** Rede engasgada não prende ninguém em "Abrindo…": passado isso, o link simples segue. */
const ACTION_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ACTION_TIMEOUT_MS))]);
}

export function VoteBoard({
  token,
  displayName,
  sellerName,
  open,
  closesLabel,
  options,
  initialCounts,
  initialTotal,
  fallbackUrl,
}: {
  token: string;
  displayName: string;
  sellerName: string;
  open: boolean;
  closesLabel: string;
  options: Option[];
  initialCounts: number[];
  initialTotal: number;
  /** wa.me sem código: se a ponte falhar, ainda chega à vendedora. */
  fallbackUrl: string | null;
}) {
  const votedRaw = useSyncExternalStore(subscribeVoted, votedSnapshot, () => "");
  const storedChoice = votedRaw ? readVotedChoice(token) : null;
  const [counts, setCounts] = useState(initialCounts);
  const [total, setTotal] = useState(initialTotal);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [nickname, setNickname] = useState("");
  const [noteSent, setNoteSent] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [voting, startVote] = useTransition();
  const [sendingNote, startNote] = useTransition();
  const [bridging, startBridge] = useTransition();

  const chosen = myChoice ?? storedChoice;
  const showResult = !open || chosen !== null;

  function vote(choice: number) {
    if (voting) return;
    setStatus(null);
    startVote(async () => {
      try {
        const result = await withTimeout(voteAction({ token, choice, voterId: getVoterId() }), { ok: false as const, reason: "inexistente" as const });
        if (result.ok || result.reason === "ja_votou") {
          writeVotedChoice(token, choice);
          setMyChoice(choice);
        }
        if (result.tally) {
          setCounts(result.tally.counts);
          setTotal(result.tally.total);
        }
        setStatus(
          result.ok
            ? `Voto na ${options[choice]?.letter ?? ""} registrado. Obrigada!`
            : result.reason === "ja_votou"
              ? "Você já votou nesta dúvida — obrigada!"
              : result.reason === "fechada"
                ? "A votação acabou de fechar. Olha como ficou:"
                : result.reason === "cheia"
                  ? "Esta votação já recebeu todos os votos que cabiam."
                  : "Não consegui registrar agora. Tente de novo em instantes.",
        );
      } catch {
        setStatus("Não consegui registrar agora. Recarregue a página e tente de novo.");
      }
    });
  }

  function sendNote() {
    if (sendingNote || note.trim() === "") return;
    startNote(async () => {
      try {
        const result = await withTimeout(noteAction({ token, voterId: getVoterId(), note, ...(nickname.trim() ? { nickname } : {}) }), {
          ok: false as const,
          reason: "inexistente" as const,
        });
        if (result.ok) {
          setNoteSent(true);
          setStatus(`Recado guardado: vai para a ${displayName} junto com o próximo placar.`);
        } else {
          setStatus(
            result.reason === "vazio"
              ? "Escreva o recado com palavras (link e telefone não vão)."
              : result.reason === "fechada"
                ? "A votação fechou antes do recado."
                : "Não consegui guardar o recado agora.",
          );
        }
      } catch {
        setStatus("Não consegui guardar o recado agora.");
      }
    });
  }

  function openBridge() {
    if (bridging) return;
    startBridge(async () => {
      let url = fallbackUrl;
      try {
        const result = await withTimeout(bridgeAction({ token }), { url: null });
        if (result.url) url = result.url;
      } catch {
        // O link simples segue.
      }
      if (url) window.location.assign(url);
      else setStatus("O WhatsApp da loja não respondeu agora. Tente de novo em instantes.");
    });
  }

  return (
    <section className="flex flex-col gap-6" aria-busy={voting}>
      <p role="status" aria-live="polite" className={`min-h-5 text-center font-store text-sm text-ink-700 ${status ? "" : "sr-only"}`}>
        {status ?? ""}
      </p>

      <ul className={`grid gap-3 sm:gap-5 ${options.length === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2"}`}>
        {options.map((option, index) => {
          const count = counts[index] ?? 0;
          const percent = total > 0 ? Math.round((count / total) * 100) : 0;
          const mine = chosen === index;
          const card = (
            <>
              <span className="relative block overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-100">
                {option.imageUrl ? (
                  <img src={option.imageUrl} alt="" className="aspect-[4/5] w-full object-cover" loading={index < 2 ? "eager" : "lazy"} />
                ) : (
                  <span className="flex aspect-[4/5] items-center justify-center font-display text-4xl text-ink-500">{option.letter}</span>
                )}
                <span aria-hidden="true" className="absolute left-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-ink-950 font-display text-lg text-ivory-50">
                  {option.letter}
                </span>
              </span>
              <span className="block font-store text-sm font-medium leading-snug text-ink-900">
                <span className="sr-only">Opção {option.letter}: </span>
                {option.name}
                {option.detail ? <span className="block text-xs font-normal text-ink-700">{option.detail}</span> : null}
              </span>
            </>
          );
          return (
            <li
              key={`${option.slug}-${index}`}
              className={`flex flex-col gap-2 ${options.length === 3 && index === 2 ? "col-span-2 mx-auto w-1/2 sm:col-span-1 sm:mx-0 sm:w-auto" : ""}`}
            >
              {showResult ? (
                <>
                  {card}
                  <span className="mt-auto flex flex-col gap-1">
                    <span className="h-2 overflow-hidden rounded-full bg-ivory-200" aria-hidden="true">
                      <span className="block h-full bg-gold-brush" style={{ width: `${percent}%` }} />
                    </span>
                    <span className="font-store text-xs tabular-nums text-ink-700">
                      {count} {count === 1 ? "voto" : "votos"}
                      {mine ? " · o seu" : ""}
                    </span>
                  </span>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => vote(index)}
                  disabled={voting}
                  className="group flex h-full flex-col gap-2 rounded-(--radius-hair) text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold-600 disabled:opacity-60"
                >
                  {card}
                  <span className="mt-auto inline-flex min-h-11 w-full items-center justify-center rounded-(--radius-hair) bg-ink-950 font-store text-sm font-medium uppercase tracking-[0.14em] text-ivory-50 transition-colors group-hover:bg-ink-800">
                    {voting ? "…" : `Votar na ${option.letter}`}
                  </span>
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {open && chosen !== null && !noteSent ? (
        <div className="flex flex-col gap-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-4 py-5">
          <p className="font-display text-lg text-ink-950">Quer mandar um recado para a {displayName}?</p>
          <label htmlFor="friends-note" className="flex flex-col gap-1 font-store text-xs text-ink-700">
            O recado (opcional)
            <textarea
              id="friends-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={140}
              rows={2}
              className={inputBase}
              placeholder="ex.: a B combina com o seu cabelo"
            />
          </label>
          <label htmlFor="friends-nickname" className="flex flex-col gap-1 font-store text-xs text-ink-700">
            Seu nome (opcional)
            <input
              id="friends-nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={30}
              className={inputBase}
              placeholder="como ela te chama"
            />
          </label>
          <button type="button" onClick={sendNote} disabled={sendingNote || note.trim() === ""} className={`${btnSmallDark} self-start`}>
            {sendingNote ? "Guardando…" : "Mandar o recado"}
          </button>
        </div>
      ) : null}

      {showResult ? (
        <div className="flex flex-col items-center gap-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-5 py-6 text-center">
          <p className="font-display text-xl text-ink-950">Quer ver peças no seu estilo também?</p>
          <p className="max-w-sm font-store text-sm text-ink-700">
            A {sellerName} é a vendedora da loja no WhatsApp: ela te mostra peças no seu tom, sem compromisso.
          </p>
          <button type="button" onClick={openBridge} disabled={bridging} aria-busy={bridging} className={`${btnOutline} w-full max-w-xs disabled:opacity-60`}>
            {bridging ? "Abrindo…" : `Falar com a ${sellerName}`}
          </button>
        </div>
      ) : (
        <p className="text-center font-store text-xs text-ink-700">Aberta até {closesLabel}.</p>
      )}
    </section>
  );
}
