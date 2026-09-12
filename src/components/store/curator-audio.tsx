"use client";
// O player da nota da curadora na vitrine. Client component só para saber
// se o aparelho toca o formato (webm gravado no Android não toca em iPhone
// antigo; ogg, em Safari antigo): quando não toca, o player some e a
// cliente lê que a nota está escrita acima — nunca um botão morto.
import { useState, useSyncExternalStore } from "react";

/** canPlayType diz "" quando o aparelho não conhece o formato; "maybe"/"probably" seguem. */
function canPlay(mime: string | null): boolean {
  if (!mime || typeof document === "undefined") return true;
  return document.createElement("audio").canPlayType(mime) !== "";
}

const noop = () => () => undefined;

export function CuratorAudio({ url, mime, hasText }: { url: string; mime: string | null; hasText: boolean }) {
  // No servidor, otimista (o HTML já vem com o player); no aparelho, a
  // resposta do canPlayType — sem setState em efeito (useSyncExternalStore
  // dá o valor do cliente já na hidratação).
  const supported = useSyncExternalStore(
    noop,
    () => canPlay(mime),
    () => true,
  );
  const [failed, setFailed] = useState(false);
  const playable = !failed && supported;
  if (!playable) {
    return (
      <p className="font-store text-[13px] text-ink-500">
        {hasText
          ? "Seu aparelho não toca este áudio — a nota está escrita acima."
          : "Seu aparelho não toca este áudio. Fale com a Lia no WhatsApp: ela conta o que a curadora disse."}
      </p>
    );
  }
  return (
    <>
      <p className="font-store text-[13px] text-ink-500">{hasText ? "Ouça na voz dela." : "Na voz dela."}</p>
      <audio
        controls
        preload="none"
        src={url}
        className="mt-2 w-full max-w-md"
        aria-label="Nota da curadora em áudio"
        onError={() => setFailed(true)}
      />
    </>
  );
}
