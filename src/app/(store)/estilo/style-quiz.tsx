"use client";
// O quiz da cartela ("espelho de estilo"): seis passos com chips e amostras
// das cores reais do catálogo, resultado com nome poético + três peças, e o
// "guardar" com telefone e consentimento explícito. O navegador guarda só o
// token; nada do que ela respondeu fica em cookie ou localStorage.
import { trackStoreEvent } from "@/components/store/analytics";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";

import { btnGold, btnOutline, eyebrowTaupe, inputBase } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { swatchHex, swatchInk } from "@/core/style/colors";
import {
  EMPTY_PROFILE,
  OCCASION_LABELS,
  OCCASIONS,
  paletteName,
  type BuysFor,
  type Fit,
  type Occasion,
  type StyleProfile,
} from "@/core/style/profile";
import { formatCentsBRL } from "@/lib/money";
import {
  readStoredStyle,
  storedStyleSnapshot,
  subscribeStoredStyle,
  writeStoredStyle,
} from "@/lib/style-storage";

import {
  curateEditionAction,
  editionForTokenAction,
  forgetStyleProfileAction,
  saveStyleProfileAction,
  forgetBodyMeasurementsFromQuizAction,
  type EditionItemView,
  type SavedStyleView,
} from "./actions";

const FIT_CARDS: { value: Fit; title: string; detail: string }[] = [
  { value: "justo", title: "Mais justo", detail: "Peças que marcam a silhueta." },
  { value: "fluido", title: "Mais fluido", detail: "Tecidos que caem soltos e leves." },
  { value: "tanto_faz", title: "Depende do dia", detail: "Gosto de alternar." },
];

const BUYS_FOR_CARDS: { value: BuysFor; title: string }[] = [
  { value: "mim", title: "Para mim" },
  { value: "presente", title: "Para presentear" },
  { value: "os_dois", title: "Os dois" },
];

const STEPS = ["Ocasiões", "Caimento", "Tamanhos", "Cores que ama", "Cores que evita", "Para quem", "Medidas"] as const;
const EMPTY_BODY = { bustCm: "", waistCm: "", hipsCm: "" };

function Chip({
  active,
  onClick,
  children,
  swatch,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  swatch?: string | null;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 py-2 font-store text-sm transition-colors duration-300 ease-silk focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600",
        active
          ? "border-2 border-espresso-900 bg-rose-300 text-espresso-900"
          : "border-ivory-400 bg-ivory-50 text-ink-700 hover:border-ink-900",
      )}
    >
      {swatch !== undefined ? (
        <span
          aria-hidden="true"
          className="inline-block h-4 w-4 rounded-full border border-ink-900/20"
          style={swatch ? { backgroundColor: swatch } : { backgroundImage: "linear-gradient(135deg,#e7dfcc,#b9b9b6)" }}
        />
      ) : null}
      {children}
    </button>
  );
}

function Swatches({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {colors.map((color) => {
        const hex = swatchHex(color) ?? "#d9c7a7";
        return (
          <span
            key={color}
            className="inline-flex items-center gap-2 rounded-full border border-ink-900/10 py-1 pr-3 pl-1 font-store text-xs"
            style={{ backgroundColor: hex, color: swatchInk(hex) }}
          >
            <span className="inline-block h-5 w-5 rounded-full border border-white/40" style={{ backgroundColor: hex }} />
            {color}
          </span>
        );
      })}
    </div>
  );
}

function EditionGrid({ items }: { items: EditionItemView[] }) {
  if (items.length === 0) {
    return (
      <p className="font-store text-sm text-ink-500">
        Ainda não temos peças que batam com a sua cartela — a coleção muda toda semana e a Lia avisa quando chegar.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {items.map((item) => (
        <li key={item.slug} className="flex flex-col gap-2">
          <Link href={`/produto/${item.slug}`} className="group block overflow-hidden rounded-(--radius-hair) border border-ivory-300 bg-ivory-50">
            <div className="aspect-[3/4] w-full bg-ivory-200">
              {item.imageUrl ? (
                <img src={item.imageUrl} alt={item.name} className="h-full w-full object-cover transition-transform duration-500 ease-silk group-hover:scale-[1.02]" />
              ) : null}
            </div>
          </Link>
          <div>
            <p className="font-display text-lg font-semibold text-espresso-900">{item.name}</p>
            <p className="font-store text-sm text-ink-700">
              {item.priceFromCents === item.priceToCents ? formatCentsBRL(item.priceFromCents) : `a partir de ${formatCentsBRL(item.priceFromCents)}`}
            </p>
            {item.reasons.length > 0 ? (
              <p className="mt-1 font-store text-xs text-gold-800">{item.reasons.join(" · ")}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function StyleQuiz({ colors, sizes }: { colors: string[]; sizes: string[] }) {
  const storedRaw = useSyncExternalStore(subscribeStoredStyle, storedStyleSnapshot, () => "");
  const stored = storedRaw ? readStoredStyle() : null;
  const [saved, setSaved] = useState<SavedStyleView | null | "loading">(null);
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<StyleProfile>(EMPTY_PROFILE);
  const [edition, setEdition] = useState<EditionItemView[] | null>(null);
  const [phone, setPhone] = useState("");
  const [consent, setConsent] = useState(false);
  // Último passo, opcional: nunca vai para o localStorage — só para o servidor, com a cartela.
  const [body, setBody] = useState(EMPTY_BODY);
  const [bodyNote, setBodyNote] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [redoing, setRedoing] = useState(false);

  // Cartela guardada neste navegador: mostra a edição de hoje em vez do quiz.
  useEffect(() => {
    if (!stored || redoing) return;
    let alive = true;
    editionForTokenAction(stored.token).then((view) => {
      if (!alive) return;
      if (view) setSaved(view);
      else {
        writeStoredStyle(null);
        setSaved(null);
      }
    });
    return () => {
      alive = false;
    };
  }, [stored?.token, redoing]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = step >= STEPS.length;
  const palette = paletteName(profile);

  function toggle<T>(list: T[], value: T, max = 8): T[] {
    return list.includes(value) ? list.filter((item) => item !== value) : list.length >= max ? list : [...list, value];
  }

  function finish() {
    setStep(STEPS.length);
    startTransition(async () => {
      const result = await curateEditionAction(profile);
      setEdition(result.items);
    });
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveStyleProfileAction({ profile, phone, consent, website: String(form.get("website") ?? ""), body });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      writeStoredStyle({
        token: result.token,
        paletteName: result.paletteName,
        savedAt: new Date().toISOString(),
        ...(result.bodyToken ? { bodyToken: result.bodyToken } : stored?.bodyToken ? { bodyToken: stored.bodyToken } : {}),
      });
      setBodyNote(result.bodyNote);
      setBody(EMPTY_BODY);
      trackStoreEvent("style_quiz_done", { palette: result.paletteName ?? "" });
      setRedoing(false);
      setMessage(null);
    });
  }

  function forget() {
    if (!stored) return;
    startTransition(async () => {
      await forgetStyleProfileAction(stored.token);
      writeStoredStyle(null);
      setSaved(null);
      setStep(0);
      setProfile(EMPTY_PROFILE);
      setEdition(null);
    });
  }

  function forgetBody() {
    if (!stored?.bodyToken || saved === null || saved === "loading") return;
    startTransition(async () => {
      const result = await forgetBodyMeasurementsFromQuizAction({ token: stored.token, bodyToken: stored.bodyToken as string });
      if (result.ok) {
        writeStoredStyle({ ...stored, bodyToken: undefined });
        setSaved({ ...saved, hasBody: false });
      }
    });
  }

  if (stored && !redoing) {
    if (saved === null || saved === "loading") {
      return <p className="font-store text-sm text-ink-500">Abrindo a sua cartela…</p>;
    }
    return (
      <div className="flex flex-col gap-8">
        <div>
          <p className={eyebrowTaupe}>A sua cartela</p>
          <h2 className="mt-2 font-display text-title font-semibold text-espresso-900">{saved.paletteName}</h2>
          <div className="mt-4">
            <Swatches colors={saved.profile.colorsLove} />
          </div>
        </div>
        <div>
          <p className={eyebrowTaupe}>A edição para você</p>
          <div className="mt-4">
            <EditionGrid items={saved.items} />
          </div>
        </div>
        {saved.hasBody ? (
          <p className="font-store text-sm text-ink-700">
            Medidas guardadas — usadas só no “Vai me servir?” das peças.{" "}
            {stored.bodyToken ? (
              <button type="button" className="text-ink-500 underline-offset-4 hover:underline" onClick={forgetBody} disabled={pending}>
                Apagar minhas medidas
              </button>
            ) : (
              <span className="text-ink-500">Para trocar ou apagar, use o aparelho em que gravou ou peça à vendedora no WhatsApp.</span>
            )}
          </p>
        ) : null}
        {bodyNote ? <p className="font-store text-xs text-ink-500">{bodyNote}</p> : null}
        <div className="flex flex-wrap gap-3">
          <button type="button" className={btnOutline} onClick={() => { setRedoing(true); setStep(0); setProfile(saved.profile); }}>
            Refazer a cartela
          </button>
          <button type="button" className="font-store text-sm text-ink-500 underline-offset-4 hover:underline" onClick={forget} disabled={pending}>
            Esquecer minha cartela
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {!finished ? (
        <ol className="flex flex-wrap gap-2" aria-label="Passos">
          {STEPS.map((label, index) => (
            <li
              key={label}
              className={cx(
                "font-store text-eyebrow uppercase",
                index === step ? "text-gold-800" : index < step ? "text-ink-700" : "text-ink-400",
              )}
            >
              {index + 1}. {label}
              {index < STEPS.length - 1 ? <span className="mx-2 text-ink-300">·</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {step === 0 ? (
        <section aria-labelledby="q-ocasioes">
          <h2 id="q-ocasioes" className="font-display text-heading font-semibold text-espresso-900">Para quais momentos você veste?</h2>
          <p className="mt-1 font-store text-sm text-ink-500">Escolha quantos quiser.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            {OCCASIONS.map((occasion) => (
              <Chip key={occasion} active={profile.occasions.includes(occasion)} onClick={() => setProfile({ ...profile, occasions: toggle<Occasion>(profile.occasions, occasion) })}>
                {OCCASION_LABELS[occasion]}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}

      {step === 1 ? (
        <section aria-labelledby="q-caimento">
          <h2 id="q-caimento" className="font-display text-heading font-semibold text-espresso-900">Como você gosta que a roupa caia?</h2>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {FIT_CARDS.map((card) => (
              <button
                key={card.value}
                type="button"
                aria-pressed={profile.fit === card.value}
                onClick={() => setProfile({ ...profile, fit: card.value })}
                className={cx(
                  "rounded-(--radius-hair) border p-4 text-left transition-colors duration-300",
                  profile.fit === card.value ? "border-2 border-espresso-900 bg-ivory-50" : "border-ivory-300 bg-ivory-50 hover:border-ink-900",
                )}
              >
                <p className="font-display text-lg font-semibold text-espresso-900">{card.title}</p>
                <p className="mt-1 font-store text-sm text-ink-700">{card.detail}</p>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section aria-labelledby="q-tamanhos">
          <h2 id="q-tamanhos" className="font-display text-heading font-semibold text-espresso-900">Que tamanho você costuma vestir?</h2>
          <p className="mt-1 font-store text-sm text-ink-500">Pule o que não souber — a Lia confirma na hora da compra.</p>
          {(["vestido", "blusa", "calca"] as const).map((key) => (
            <div key={key} className="mt-5">
              <p className={eyebrowTaupe}>{key === "vestido" ? "Vestidos" : key === "blusa" ? "Blusas" : "Calças e saias"}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {sizes.map((size) => (
                  <Chip
                    key={size}
                    active={profile.sizes[key] === size}
                    onClick={() => setProfile({ ...profile, sizes: { ...profile.sizes, [key]: profile.sizes[key] === size ? undefined : size } })}
                  >
                    {size}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {step === 3 || step === 4 ? (
        <section aria-labelledby="q-cores">
          <h2 id="q-cores" className="font-display text-heading font-semibold text-espresso-900">
            {step === 3 ? "Quais cores você ama vestir?" : "E quais você prefere evitar?"}
          </h2>
          <p className="mt-1 font-store text-sm text-ink-500">
            {step === 3 ? "As cores da coleção de hoje. Até quatro." : "Nunca vamos sugerir uma peça só nessas cores."}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {colors.map((color) => {
              const list = step === 3 ? profile.colorsLove : profile.colorsAvoid;
              const other = step === 3 ? profile.colorsAvoid : profile.colorsLove;
              return (
                <Chip
                  key={color}
                  active={list.includes(color)}
                  swatch={swatchHex(color)}
                  onClick={() => {
                    const next = toggle(list, color, step === 3 ? 4 : 8);
                    setProfile(
                      step === 3
                        ? { ...profile, colorsLove: next, colorsAvoid: other.filter((c) => !next.includes(c)) }
                        : { ...profile, colorsAvoid: next, colorsLove: other.filter((c) => !next.includes(c)) },
                    );
                  }}
                >
                  {color}
                </Chip>
              );
            })}
            {colors.length === 0 ? <p className="font-store text-sm text-ink-500">A coleção ainda não tem cores cadastradas.</p> : null}
          </div>
        </section>
      ) : null}

      {step === 5 ? (
        <section aria-labelledby="q-para-quem">
          <h2 id="q-para-quem" className="font-display text-heading font-semibold text-espresso-900">Você costuma comprar para quem?</h2>
          <div className="mt-5 flex flex-wrap gap-2">
            {BUYS_FOR_CARDS.map((card) => (
              <Chip key={card.value} active={profile.buysFor === card.value} onClick={() => setProfile({ ...profile, buysFor: card.value })}>
                {card.title}
              </Chip>
            ))}
          </div>
        </section>
      ) : null}

      {step === 6 ? (
        <section aria-labelledby="q-medidas">
          <h2 id="q-medidas" className="font-display text-heading font-semibold text-espresso-900">Suas medidas (opcional)</h2>
          <p className="mt-2 font-store text-sm text-ink-700">
            Busto, cintura e quadril em centímetros — com elas, cada peça com tabela responde “vai me servir?”. Ficam na sua cartela, só este aparelho (e a vendedora, no seu WhatsApp) consegue lê-las, e você apaga quando quiser. Pode pular.
          </p>
          <div className="mt-5 grid grid-cols-3 gap-3">
            {(["bustCm", "waistCm", "hipsCm"] as const).map((key) => (
              <label key={key} className="flex flex-col gap-1">
                <span className="font-store text-[11px] font-medium uppercase tracking-[0.14em] text-ink-700">{key === "bustCm" ? "Busto" : key === "waistCm" ? "Cintura" : "Quadril"}</span>
                <input
                  id={`quiz-${key}`}
                  type="number"
                  inputMode="numeric"
                  min={40}
                  max={200}
                  step={1}
                  placeholder="cm"
                  value={body[key]}
                  onChange={(event) => setBody((current) => ({ ...current, [key]: event.target.value }))}
                  className={inputBase}
                />
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {!finished ? (
        <div className="flex flex-wrap items-center gap-3">
          {step > 0 ? (
            <button type="button" className={btnOutline} onClick={() => setStep(step - 1)}>
              Voltar
            </button>
          ) : null}
          {step < STEPS.length - 1 ? (
            <button type="button" className={btnGold} onClick={() => setStep(step + 1)}>
              Próximo
            </button>
          ) : (
            <>
              <button type="button" className={btnGold} onClick={finish}>
                Ver a minha cartela
              </button>
              <button
                type="button"
                className={btnOutline}
                onClick={() => {
                  setBody(EMPTY_BODY);
                  finish();
                }}
              >
                Pular
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <div>
            <p className={eyebrowTaupe}>A sua cartela</p>
            <h2 className="mt-2 font-display text-title font-semibold text-espresso-900">{palette}</h2>
            <div className="mt-4">
              <Swatches colors={profile.colorsLove} />
            </div>
          </div>
          <div>
            <p className={eyebrowTaupe}>Três peças para você</p>
            <div className="mt-4">
              {edition === null ? <p className="font-store text-sm text-ink-500">Escolhendo as peças…</p> : <EditionGrid items={edition} />}
            </div>
          </div>
          <form onSubmit={save} className="flex flex-col gap-3 rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 p-5">
            <p className="font-display text-heading font-semibold text-espresso-900">Guardar a minha cartela</p>
            <p className="font-store text-sm text-ink-700">
              Guardamos a cartela no seu WhatsApp para a Lia e a vitrine lembrarem de você. Você pode esquecer tudo quando quiser.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="(11) 99999-9999"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                required
                aria-label="Seu WhatsApp"
                className={cx(inputBase, "flex-1")}
              />
              <button type="submit" disabled={pending || !consent} className={cx(btnGold, "min-h-11 px-6 py-3")}>
                {pending ? "Guardando…" : "Guardar minha cartela"}
              </button>
            </div>
            <label className="flex cursor-pointer items-start gap-2 font-store text-xs text-ink-700">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-gold-600" />
              <span>Autorizo guardar as minhas respostas ligadas a este WhatsApp para receber sugestões da maison. Sem novidades por mensagem sem o meu sim.</span>
            </label>
            <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
            {message ? <p className="font-store text-xs text-claret-600" role="alert">{message}</p> : null}
            <button type="button" className="self-start font-store text-xs text-ink-500 underline-offset-4 hover:underline" onClick={() => setStep(0)}>
              Refazer as respostas
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
