import type { ReactNode } from "react";
import { cx } from "./cx";

export type TableHeader =
  | string
  | { label: string; align?: "left" | "right"; className?: string };

export function Table({
  headers,
  children,
  className,
  /** Sem moldura própria: para dentro de um <Card padding="none">. */
  bare = false,
}: {
  headers: TableHeader[];
  children: ReactNode;
  className?: string;
  bare?: boolean;
}) {
  return (
    <div
      className={cx(
        "overflow-x-auto",
        bare
          ? "rounded-b-xl"
          : "rounded-xl border border-zinc-200/80 dark:border-zinc-800",
        className,
      )}
    >
      <table className="w-full border-collapse bg-white text-left text-sm dark:bg-zinc-900">
        <thead>
          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {headers.map((header, index) => {
              const item = typeof header === "string" ? { label: header } : header;
              return (
                <th
                  key={`${index}-${item.label}`}
                  className={cx(
                    "px-4 py-3 font-medium",
                    item.align === "right" && "text-right",
                    item.className,
                  )}
                >
                  {item.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Tr({
  children,
  className,
  muted = false,
}: {
  children: ReactNode;
  className?: string;
  /** Linha "apagada" (desativado, arquivado). */
  muted?: boolean;
}) {
  return (
    <tr
      className={cx(
        "border-b border-zinc-100 transition-colors last:border-b-0 even:bg-zinc-50/60 hover:bg-zinc-50 dark:border-zinc-800 dark:even:bg-zinc-800/30 dark:hover:bg-zinc-800/50",
        muted && "opacity-60",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
  colSpan,
  align = "left",
}: {
  children?: ReactNode;
  className?: string;
  colSpan?: number;
  /** "right" para números: alinha e usa figuras tabulares. */
  align?: "left" | "right";
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        "px-4 py-3 text-zinc-700 dark:text-zinc-300",
        align === "right" && "text-right tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}
