// Contador dos crachás do menu (Conversas, E-mails). Ouro sobre noir: o
// número é a única coisa "acesa" na lateral, e é isso que se quer.
export function NavCount({
  count,
  srLabel,
  title,
}: {
  count: number;
  /** Complemento só para leitores de tela: " e-mails aguardando resposta". */
  srLabel?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-gold-400 px-1.5 text-[11px] font-semibold tabular-nums text-noir-950"
    >
      {count}
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
    </span>
  );
}
