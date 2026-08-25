import type { ReactNode } from "react";
import { cx } from "./cx";

export function Table({
  headers,
  children,
  className,
}: {
  headers: string[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800",
        className,
      )}
    >
      <table className="w-full border-collapse bg-white text-left text-sm dark:bg-zinc-900">
        <thead>
          <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {headers.map((header, index) => (
              <th key={`${index}-${header}`} className="px-4 py-3 font-medium">
                {header}
              </th>
            ))}
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
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr
      className={cx(
        "border-b border-zinc-100 last:border-b-0 even:bg-zinc-50/60 dark:border-zinc-800 dark:even:bg-zinc-800/30",
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
}: {
  children?: ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx("px-4 py-3 text-zinc-700 dark:text-zinc-300", className)}
    >
      {children}
    </td>
  );
}
