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

export function IconChevron({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Balão do WhatsApp em traço fino, no mesmo vocabulário dos demais ícones. */
export function IconWhatsApp({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5Z" />
      <path d="M9.2 8.6c.2-.4.5-.4.8-.4h.4c.2 0 .4 0 .6.4l.7 1.6c.1.2 0 .4-.1.5l-.5.6c-.1.1-.1.3 0 .5a6 6 0 0 0 2.9 2.7c.2.1.4.1.5-.1l.6-.7c.2-.2.4-.2.6-.1l1.6.8c.3.1.4.3.4.5-.1.9-.7 1.6-1.6 1.7-1.2.2-3.6-.6-5.3-2.4-1.7-1.7-2.4-3.6-2.3-4.8.1-.5.4-1.2.7-1.8Z" />
    </svg>
  );
}

// Pictogramas de cuidado da placa de museu (mesmo traço fino, herdam a cor).
export function IconHandWash({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M4 10h16l-1.5 8h-13L4 10Z" />
      <path d="M12 3v4M9 5l1.5 2M15 5l-1.5 2" />
    </svg>
  );
}

export function IconMachineCold({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="12" cy="13" r="4" />
      <path d="M7 7h2M15 7h2" />
    </svg>
  );
}

export function IconNoBleach({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M12 4 20 19H4L12 4Z" />
      <path d="M5 5l14 14" />
    </svg>
  );
}

export function IconDryShade({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="4" y="4" width="16" height="16" rx="1" />
      <path d="M4 20 20 4" />
      <path d="M8 4v6M12 4v4" />
    </svg>
  );
}

export function IconIronLow({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 16h13a1 1 0 0 0 1-1v-4a5 5 0 0 0-5-5H9" />
      <path d="M4 16h16" />
      <circle cx="12" cy="12" r="0.6" />
    </svg>
  );
}

export function IconNoIron({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <path d="M6 16h13a1 1 0 0 0 1-1v-4a5 5 0 0 0-5-5H9" />
      <path d="M4 16h16" />
      <path d="M5 5l14 14" />
    </svg>
  );
}

export function IconDryClean({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M9 14a3 3 0 0 0 6 0" />
    </svg>
  );
}

export function IconNoTumble({ className }: IconProps) {
  return (
    <svg {...baseProps(className)}>
      <rect x="4" y="4" width="16" height="16" rx="1" />
      <circle cx="12" cy="12" r="4" />
      <path d="M5 5l14 14" />
    </svg>
  );
}
