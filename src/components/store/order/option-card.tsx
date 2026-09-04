// Opção escolhível (entrega, pagamento): <label> com o radio nativo visível
// (é ele que recebe o anel de foco e cumpre o limite de componente), borda de
// 2px dourada + check quando marcada, alvo ≥ 44px. Sem hooks: os formulários
// cliente da sacola e do checkout a renderizam.
import type { ChangeEventHandler, ReactNode } from "react";

import { IconCheck } from "@/components/store/icons";
import { cx } from "@/components/ui/cx";

export function OptionCard({
  name,
  value,
  checked,
  onChange,
  title,
  detail,
  trailing,
  disabled = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  title: ReactNode;
  detail?: ReactNode;
  /** Preço ou "Grátis", alinhado à direita. */
  trailing?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-(--radius-hair) border-2 px-3.5 py-3 transition-colors duration-300 ease-silk",
        checked
          ? "border-gold-600 bg-gold-500/8"
          : "border-ivory-300 hover:border-ivory-400",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-5 w-5 shrink-0 accent-gold-600"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-store text-sm font-medium text-ink-900">{title}</span>
        {detail ? (
          <span className="font-store text-xs text-ink-500">{detail}</span>
        ) : null}
      </span>
      {trailing !== undefined ? (
        <span className="shrink-0 font-store text-sm font-medium text-ink-900 tabular-nums">
          {trailing}
        </span>
      ) : null}
      {checked ? (
        <IconCheck className="h-4 w-4 shrink-0 text-gold-700" />
      ) : null}
    </label>
  );
}
