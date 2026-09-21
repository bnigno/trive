import { Badge, type BadgeTone } from "./badge";

export function StatusPill({
  label,
  tone,
  dot = false,
  className,
}: {
  label: string;
  tone: BadgeTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <Badge tone={tone} dot={dot} className={className}>
      {label}
    </Badge>
  );
}

const PRICE_STATUS_TONES: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "info",
  active: "success",
  rejected: "danger",
  superseded: "neutral",
};

const ORDER_STATUS_TONES: Record<string, BadgeTone> = {
  draft: "neutral",
  pending_payment: "warning",
  paid: "success",
  preparing: "info",
  shipped: "info",
  delivered: "success",
  canceled: "danger",
  refunded: "danger",
};

export function priceStatusTone(status: string): BadgeTone {
  return PRICE_STATUS_TONES[status] ?? "neutral";
}

export function orderStatusTone(status: string): BadgeTone {
  return ORDER_STATUS_TONES[status] ?? "neutral";
}
