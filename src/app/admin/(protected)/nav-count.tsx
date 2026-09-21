// Contador dos crachás do menu (Conversas, E-mails). Ouro sobre noir é o
// que pede você; neutro é o que só informa (a vendedora está cuidando).
export function NavCount({
  count,
  srLabel,
  title,
  tone = "gold",
}: {
  count: number;
  /** Complemento só para leitores de tela: " e-mails aguardando resposta". */
  srLabel?: string;
  title?: string;
  tone?: "gold" | "neutral";
}) {
  return (
    <span
      title={title}
      className={
        tone === "gold"
          ? "ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-gold-400 px-1.5 text-[11px] font-semibold tabular-nums text-noir-950"
          : "ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-white/15 px-1.5 text-[11px] font-semibold tabular-nums text-zinc-200"
      }
    >
      {count}
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
    </span>
  );
}
