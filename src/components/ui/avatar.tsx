import { cx } from "./cx";

type AvatarSize = "sm" | "md" | "lg";

const sizeClasses: Record<AvatarSize, string> = {
  sm: "size-8 text-[11px]",
  md: "size-9 text-xs",
  lg: "size-14 text-lg",
};

// Pares fundo/texto discretos: identificam a pessoa sem competir com os
// tons semânticos (success/warning/danger) usados nos badges ao lado.
const PALETTE = [
  "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100",
  "bg-stone-200 text-stone-800 dark:bg-stone-700 dark:text-stone-100",
  "bg-indigo-100 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-100",
  "bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
  "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
] as const;

/** "Ana Souza" → "AS"; "ana@x.com" (sem nome) → "A". */
export function initialsOf(name: string | null, fallback: string): string {
  const words = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return fallback.trim().charAt(0).toUpperCase() || "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return `${first}${last}`.toUpperCase();
}

function hashOf(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function Avatar({
  name,
  fallback,
  size = "md",
  className,
}: {
  name: string | null;
  /** Normalmente o e-mail: dá a inicial quando não há nome e fixa a cor. */
  fallback: string;
  size?: AvatarSize;
  className?: string;
}) {
  const tone = PALETTE[hashOf(fallback.toLowerCase()) % PALETTE.length];
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none",
        sizeClasses[size],
        tone,
        className,
      )}
    >
      {initialsOf(name, fallback)}
    </span>
  );
}
