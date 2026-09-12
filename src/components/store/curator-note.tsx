// "A nota da curadora" na página da peça: o texto em itálico serifado, como
// uma carta, e o player nativo do áudio quando ela gravou. Server component;
// some quando a peça não tem nota nem áudio. Só apresenta: texto e URL
// chegam prontos da página.
import { CuratorAudio } from "@/components/store/curator-audio";
import { eyebrow } from "@/components/store/styles";

export type CuratorNoteData = {
  note: string | null;
  audioUrl: string | null;
  audioMime: string | null;
};

export function hasCuratorNote(data: CuratorNoteData): boolean {
  return Boolean(data.note?.trim() || data.audioUrl);
}

/** Tira as aspas das pontas quando a nota inteira veio entre aspas: o bloco já põe as dele. */
function unquote(note: string): string {
  const trimmed = note.trim();
  const quote = /["'“”‘’«»]/;
  return quote.test(trimmed.charAt(0)) && quote.test(trimmed.charAt(trimmed.length - 1)) ? trimmed.slice(1, -1).trim() : trimmed;
}

export function CuratorNote({ data }: { data: CuratorNoteData }) {
  const paragraphs = unquote(data.note ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    <section aria-labelledby="nota-da-curadora" className="mt-8 border-t border-ivory-300 pt-6">
      <p id="nota-da-curadora" className={eyebrow}>
        A nota da curadora
      </p>
      {paragraphs.length > 0 ? (
        <blockquote className="mt-3 font-display text-[1.15rem] leading-8 text-espresso-900 italic">
          {paragraphs.map((paragraph, index) => (
            <p key={index} className={index > 0 ? "mt-3" : undefined}>
              {index === 0 ? "“" : ""}
              {paragraph}
              {index === paragraphs.length - 1 ? "”" : ""}
            </p>
          ))}
        </blockquote>
      ) : null}
      {data.audioUrl ? (
        <div className="mt-4">
          <CuratorAudio url={data.audioUrl} mime={data.audioMime} hasText={paragraphs.length > 0} />
        </div>
      ) : null}
    </section>
  );
}
