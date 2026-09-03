// Receitas de classes da vitrine "Noite de Estreia". Regras de cor (WCAG AA
// calculado, ver o @theme em src/app/globals.css): preço sempre em ink-900;
// dourado nunca como texto pequeno em fundo claro (gold-700 só sobre
// ivory-100; em faixas ivory-200 use gold-800); taupe-600 só sobre
// ivory-50/100; rose-700 é o único rosé que serve como texto pequeno em
// marfim; sobre noir o ouro pode ser texto grande; foco gold-600 em marfim e
// gold-200 em noir. Todo alvo tocável tem no mínimo 44px.

export const eyebrow =
  "font-store text-eyebrow font-medium uppercase text-ink-500";

/** Eyebrow sobre noir (gold-400 tem 10,3:1 sobre noir-950). */
export const eyebrowNoir =
  "font-store text-eyebrow font-medium uppercase text-gold-400";

/** Eyebrow em taupe, a cor da tagline do logo — só sobre ivory-50/100. */
export const eyebrowTaupe =
  "font-store text-eyebrow font-medium uppercase text-taupe-600";

export const btnPrimary =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-(--radius-hair) bg-ink-950 px-7 py-3.5 font-store text-sm font-medium uppercase tracking-[0.16em] text-ivory-50 transition-colors duration-300 ease-silk hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

export const btnOutline =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-(--radius-hair) border border-ink-900/80 px-7 py-3.5 font-store text-sm font-medium uppercase tracking-[0.16em] text-ink-900 transition-colors duration-300 ease-silk hover:border-gold-600 hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

/** CTA sobre noir: ouro escovado sólido com texto noir (contraste 6,8:1). */
export const btnGold =
  "press-sheen inline-flex min-h-13 items-center justify-center gap-2 rounded-(--radius-hair) bg-gold-brush px-8 py-4 font-store text-sm font-medium uppercase tracking-[0.18em] text-noir-950 transition-colors duration-300 ease-silk hover:bg-gold-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200";

/** Botão de contorno sobre noir. */
export const btnOutlineNoir =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-(--radius-hair) border border-gold-500/60 px-7 py-3.5 font-store text-sm font-medium uppercase tracking-[0.16em] text-gold-200 transition-colors duration-300 ease-silk hover:border-gold-300 hover:bg-gold-400/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200";

export const inputBase =
  "w-full appearance-none rounded-none border-0 border-b border-ivory-300 bg-transparent px-0.5 py-2 font-store text-sm text-ink-900 placeholder:text-ink-400 transition-colors duration-300 focus:border-gold-600 focus:outline-none";

export const hairline = "border-ivory-300";

/** Hairline sobre noir: ouro a 20%. */
export const hairlineNoir = "border-gold-500/20";
