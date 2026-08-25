"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { cx } from "./cx";

export function Field({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("flex flex-col gap-1.5 text-sm", className)}>
      <span className="font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </span>
      {children}
      {hint && !error ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </label>
  );
}

const controlClasses =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={cx(controlClasses, className)} />;
}

export function Select({
  className,
  children,
  ...props
}: ComponentProps<"select">) {
  return (
    <select {...props} className={cx(controlClasses, className)}>
      {children}
    </select>
  );
}

export function TextArea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea {...props} className={cx(controlClasses, "min-h-24", className)} />
  );
}

export type ButtonVariant = "primary" | "danger" | "ghost" | "outline";
export type ButtonSize = "sm" | "md";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-500",
  danger: "bg-red-600 text-white hover:bg-red-500",
  ghost:
    "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  outline:
    "border border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cx(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    />
  );
}

export function SubmitButton({
  pendingLabel = "Salvando…",
  disabled,
  children,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button {...props} type="submit" disabled={pending || disabled}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
    >
      {message}
    </p>
  );
}

export function FormSuccess({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    >
      {message}
    </p>
  );
}
