import { Search } from "lucide-react";
import { cx } from "./cx";

/**
 * Busca por GET, sem JavaScript: Enter envia, a URL vira o estado. Os outros
 * filtros da página entram como campos ocultos para a busca não apagá-los.
 */
export function SearchForm({
  action,
  name = "q",
  defaultValue,
  placeholder,
  keep,
  className,
}: {
  action: string;
  name?: string;
  defaultValue?: string;
  placeholder: string;
  /** Parâmetros a preservar (valores vazios são ignorados). */
  keep?: Record<string, string | undefined>;
  className?: string;
}) {
  return (
    <form action={action} method="get" role="search" className={cx("relative", className)}>
      {Object.entries(keep ?? {}).map(([key, value]) =>
        value ? <input key={key} type="hidden" name={key} value={value} /> : null,
      )}
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
      />
      <input
        type="search"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
      />
    </form>
  );
}
