// Cartela de estilo da cliente no painel: o que ela contou, de onde veio, e
// o botão "Esquecer" (LGPD) — zera tudo e a vitrine/vendedora param de usar.
import { swatchHex, swatchInk } from "@/core/style/colors";
import { OCCASION_LABELS } from "@/core/style/profile";
import type { StyleProfileView } from "@/services/style-profiles";

const SOURCE_LABEL: Record<string, string> = {
  quiz: "quiz da vitrine",
  lia: "contado à vendedora",
  admin: "anotado por você",
  checkout: "checkout",
};

const FIT_LABEL: Record<string, string> = { justo: "mais justo", fluido: "mais fluido", tanto_faz: "tanto faz" };
const BUYS_FOR_LABEL: Record<string, string> = { mim: "para ela", presente: "para presentear", os_dois: "para ela e para presentear" };

export function StyleProfileCard({
  profile,
  customerId,
  forgetAction,
}: {
  profile: StyleProfileView | null;
  customerId: string;
  forgetAction: (formData: FormData) => Promise<void>;
}) {
  if (!profile) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Sem cartela ainda. Ela nasce no quiz da vitrine (/estilo) ou quando a cliente conta tamanhos e cores à vendedora.
      </p>
    );
  }
  const p = profile.profile;
  const sizes = Object.entries(p.sizes).filter(([, v]) => v);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{profile.paletteName}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {SOURCE_LABEL[profile.source] ?? profile.source} · {profile.consentAt ? "com consentimento" : "sem consentimento explícito"}
        </p>
      </div>
      {p.colorsLove.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {p.colorsLove.map((color) => {
            const hex = swatchHex(color) ?? "#d9c7a7";
            return (
              <span key={color} className="rounded-full px-2.5 py-1 text-xs" style={{ backgroundColor: hex, color: swatchInk(hex) }}>
                {color}
              </span>
            );
          })}
        </div>
      ) : null}
      <dl className="grid gap-1.5 sm:grid-cols-2">
        {sizes.length > 0 ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">Tamanhos</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{sizes.map(([k, v]) => `${k === "calca" ? "calças/saias" : k === "blusa" ? "blusas" : "vestidos"} ${v}`).join(" · ")}</dd>
          </div>
        ) : null}
        {p.colorsAvoid.length > 0 ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">Evita</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{p.colorsAvoid.join(", ")}</dd>
          </div>
        ) : null}
        {p.fit ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">Caimento</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{FIT_LABEL[p.fit] ?? p.fit}</dd>
          </div>
        ) : null}
        {p.occasions.length > 0 ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">Ocasiões</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{p.occasions.map((o) => OCCASION_LABELS[o]).join(", ")}</dd>
          </div>
        ) : null}
        {p.buysFor ? (
          <div>
            <dt className="text-xs uppercase tracking-wide text-zinc-500">Compra</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{BUYS_FOR_LABEL[p.buysFor] ?? p.buysFor}</dd>
          </div>
        ) : null}
      </dl>
      <form action={forgetAction} className="mt-1">
        <input type="hidden" name="profileId" value={profile.id} />
        <input type="hidden" name="customerId" value={customerId} />
        <button type="submit" className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
          Esquecer a cartela (LGPD)
        </button>
      </form>
    </div>
  );
}
