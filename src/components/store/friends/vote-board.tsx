"use client";
// As peças lado a lado, um toque para votar e, depois, o placar e o convite
// para falar com a vendedora. O recado é opcional e vai para a cliente pelo
// WhatsApp da loja (sem link — o servidor tira).
import { useState, useSyncExternalStore, useTransition } from "react";

import { btnOutline, btnPrimary, inputBase } from "@/components/store/styles";
import { getVoterId, readVotedChoice, subscribeVoted, votedSnapshot, writeVotedChoice } from "@/lib/friends-storage";

import { bridgeAction, voteAction } from "@/app/(store)/v/[token]/actions";

type Option = { letter: string; name: string; detail: string | null; imageUrl: string | null; slug: string };

export function VoteBoard({
  token,
  displayName,
  sellerName,
  open,
  options,
  initialCounts,
  initialTotal,
}: {
  token: string;
  displayName: string;
  sellerName: string;
  open: boolean;
  options: Option[];
  initialCounts: number[];
  initialTotal: number;
}) {
  const votedRaw = useSyncExternalStore(subscribeVoted, votedSnapshot, () => "");
  const storedChoice = votedRaw ? readVotedChoice(token) : null;
  const [counts, setCounts] = useState(initialCounts);
  const [total, setTotal] = useState(initialTotal);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [nickname, setNickname] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [bridging, startBridge] = useTransition();

  const chosen = myChoice ?? storedChoice;
  const showResult = !open || chosen !== null;

  function vote(choice: number) {
    setMessage(null);
    startTransition(async () => {
      const result = await voteAction({
        token,
        choice,
        voterId: getVoterId(),
        ...(note.trim() ? { note } : {}),
        ...(nickname.trim() ? { nickname } : {}),
      });
      if (result.ok || result.reason === "ja_votou") {
        writeVotedChoice(token, choice);
        setMyChoice(choice);
      }
      if (result.tally) {
        setCounts(result.tally.counts);
        setTotal(result.tally.total);
      }
      if (!result.ok) {
        setMessage(
          result.reason === "ja_votou"
            ? "Você já votou nesta dúvida — obrigada!"
            : result.reason === "fechada"
              ? "A votação acabou de fechar. Olha como ficou:"
              : "Não consegui registrar agora. Tente de novo em instantes.",
        );
      }
    });
  }

  function openBridge() {
    startBridge(async () => {
      const { url } = await bridgeAction({ token });
      if (url) window.location.assign(url);
      else setMessage("O WhatsApp da loja não respondeu agora. Tente de novo em instantes.");
    });
  }

  const columns = options.length === 3 ? "grid-cols-3" : "grid-cols-2";

  return (
    <section className="flex flex-col gap-6">
      <div className={`grid ${columns} gap-3 sm:gap-5`}>
        {options.map((option, index) => {
          const count = counts[index] ?? 0;
          const percent = total > 0 ? Math.round((count / total) * 100) : 0;
          const mine = chosen === index;
          return (
            <div key={`${option.slug}-${index}`} className="flex flex-col gap-2">
              <div className="relative overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-100">
                {option.imageUrl ? (
                  <img src={option.imageUrl} alt={option.name} className="aspect-[4/5] w-full object-cover" loading={index === 0 ? "eager" : "lazy"} />
                ) : (
                  <div className="flex aspect-[4/5] items-center justify-center font-display text-4xl text-ink-400">{option.letter}</div>
                )}
                <span className="absolute left-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-ink-950 font-display text-lg text-ivory-50">
                  {option.letter}
                </span>
              </div>
              <p className="font-store text-sm font-medium leading-snug text-ink-900">
                {option.name}
                {option.detail ? <span className="block text-xs font-normal text-ink-600">{option.detail}</span> : null}
              </p>
              {showResult ? (
                <div aria-label={`${option.letter}: ${count} ${count === 1 ? "voto" : "votos"}`}>
                  <div className="h-2 overflow-hidden rounded-full bg-ivory-200">
                    <div className="h-full bg-gold-brush" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="mt-1 font-store text-xs tabular-nums text-ink-600">
                    {count} {count === 1 ? "voto" : "votos"}
                    {mine ? " · o seu" : ""}
                  </p>
                </div>
              ) : (
                <button type="button" onClick={() => vote(index)} disabled={pending} className={`${btnPrimary} w-full px-3 disabled:opacity-60`}>
                  {pending ? "…" : `Voto na ${option.letter}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!showResult ? (
        <div className="flex flex-col gap-3">
          {showNote ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 font-store text-xs text-ink-600">
                Um recado para a {displayName} (opcional)
                <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={140} rows={2} className={inputBase} placeholder="ex.: a B combina com o seu cabelo" />
              </label>
              <label className="flex flex-col gap-1 font-store text-xs text-ink-600">
                Seu nome (opcional)
                <input value={nickname} onChange={(event) => setNickname(event.target.value)} maxLength={30} className={inputBase} placeholder="como ela te chama" />
              </label>
              <p className="font-store text-xs text-ink-500">Escreva e depois toque na sua escolha acima.</p>
            </div>
          ) : (
            <button type="button" onClick={() => setShowNote(true)} className="self-center font-store text-sm text-ink-700 underline underline-offset-4">
              Deixar um recado junto com o voto
            </button>
          )}
        </div>
      ) : null}

      {message ? (
        <p role="status" className="text-center font-store text-sm text-ink-700">
          {message}
        </p>
      ) : null}

      {showResult ? (
        <div className="flex flex-col items-center gap-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 px-5 py-6 text-center">
          <p className="font-display text-xl text-ink-950">Quer ver peças no seu estilo também?</p>
          <p className="max-w-sm font-store text-sm text-ink-600">
            A {sellerName} é a vendedora da loja no WhatsApp: ela te mostra peças no seu tom, sem compromisso.
          </p>
          <button type="button" onClick={openBridge} disabled={bridging} className={`${btnOutline} w-full max-w-xs disabled:opacity-60`}>
            {bridging ? "Abrindo…" : `Falar com a ${sellerName}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}
