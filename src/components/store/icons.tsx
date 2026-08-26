// Ícones da vitrine: traço fino (stroke 1.5), herdam cor via currentColor.
// Sem dependência externa — a boutique não usa emoji nem libs de ícone.

type IconProps = { className?: string };

function baseProps(className?: string) {
  return {
    "aria-hidden": true,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    className: className ?? "h-5 w-5",
  } as const;
}

export function IconParcel({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4" />
      <path d="M12 11v10" />
      <path d="m8 5 8 4" />
    </svg>
  );
}

export function IconShield({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m12 3 7 3v5c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6l7-3Z" />
      <path d="m9.3 12.1 1.9 1.9 3.5-3.8" />
    </svg>
  );
}

export function IconExchange({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 9h13l-3.2-3.2" />
      <path d="M20 15H7l3.2 3.2" />
    </svg>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </svg>
  );
}

export function IconBag({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 8h12l1 12a1.6 1.6 0 0 1-1.6 1.7H6.6A1.6 1.6 0 0 1 5 20L6 8Z" />
      <path d="M9 10V6a3 3 0 0 1 6 0v4" />
    </svg>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconArrowRight({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 12h15" />
      <path d="m13.5 6.5 5.5 5.5-5.5 5.5" />
    </svg>
  );
}
