// Ticks de status das mensagens enviadas, no vocabulário do WhatsApp:
// relógio = na fila, ✓ = enviada, ✓✓ = entregue, ✓✓ azul = lida, ⚠ = falhou.
// SVGs próprios (sem lib de ícones); cor herdada via currentColor.
const STATUS_LABELS: Record<string, string> = {
  queued: "na fila de envio",
  sent: "enviada",
  delivered: "entregue",
  read: "lida",
  failed: "falhou",
};

function ClockIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
      <circle cx="6" cy="6" r="4.8" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M6 3.4V6l1.7 1.1"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SingleCheckIcon() {
  return (
    <svg viewBox="0 0 16 11" width="15" height="11" fill="none">
      <path
        d="M2 5.7 5.3 9 12 1.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DoubleCheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 11"
      width="15"
      height="11"
      fill="none"
      className={className}
    >
      <path
        d="M1 5.7 4.3 9 11 1.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 7.5 8.9 9 15.6 1.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FailedIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" className={className}>
      <circle cx="7" cy="7" r="5.8" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M7 3.9v3.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="7" cy="10.1" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function MessageTicks({ status }: { status: string }) {
  let icon: React.ReactNode = null;
  if (status === "queued") icon = <ClockIcon />;
  else if (status === "sent") icon = <SingleCheckIcon />;
  else if (status === "delivered") icon = <DoubleCheckIcon />;
  else if (status === "read") {
    icon = <DoubleCheckIcon className="text-[#53bdeb]" />;
  } else if (status === "failed") {
    icon = <FailedIcon className="text-red-500" />;
  }
  if (icon === null) return null;

  return (
    <span className="inline-flex items-center">
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
      <span className="sr-only">{STATUS_LABELS[status] ?? status}</span>
    </span>
  );
}
