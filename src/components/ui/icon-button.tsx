import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

type IconButtonVariant = "ghost" | "outline" | "danger" | "noir";
type IconButtonSize = "sm" | "md";

// A cor do anel de foco vai junto da variante: sobre noir o índigo some.
const variantClasses: Record<IconButtonVariant, string> = {
  ghost:
    "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-indigo-500/40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
  outline:
    "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 focus-visible:ring-indigo-500/40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800",
  danger:
    "text-red-600 hover:bg-red-50 focus-visible:ring-red-500/40 dark:text-red-400 dark:hover:bg-red-950/60",
  /** Para a lateral escura do painel (igual nos dois modos). */
  noir: "text-zinc-400 hover:bg-white/10 hover:text-white focus-visible:ring-gold-400/60",
};

// 36 px é o mínimo confortável para o polegar; "sm" só onde a linha é densa.
const sizeClasses: Record<IconButtonSize, string> = {
  sm: "size-8",
  md: "size-9",
};

export function iconButtonClassName({
  variant = "ghost",
  size = "md",
  className,
}: {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  className?: string;
}): string {
  return cx(
    "inline-grid shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40",
    variantClasses[variant],
    sizeClasses[size],
    className,
  );
}

type SharedProps = {
  /** O que o botão faz — vira aria-label e title (o ícone sozinho não explica). */
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
};

export function IconButton({
  label,
  icon,
  variant,
  size,
  className,
  type = "button",
  ...props
}: SharedProps & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={label}
      className={iconButtonClassName({ variant, size, className })}
    >
      {icon}
    </button>
  );
}

export function IconButtonLink({
  label,
  icon,
  variant,
  size,
  className,
  ...props
}: SharedProps & Omit<ComponentProps<typeof Link>, "children">) {
  return (
    <Link
      {...props}
      aria-label={label}
      title={label}
      className={iconButtonClassName({ variant, size, className })}
    >
      {icon}
    </Link>
  );
}
