// Ornamento tipográfico da maison: losango entre filetes. Herda a cor via
// currentColor — o caller define (ex.: className="text-gold-500").
import { cx } from "@/components/ui/cx";

export function Ornament({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 12"
      width={120}
      height={12}
      fill="none"
      className={cx("shrink-0", className)}
    >
      <line
        x1="0"
        y1="6"
        x2="48"
        y2="6"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.55"
      />
      <rect
        x="55.8"
        y="1.8"
        width="8.4"
        height="8.4"
        transform="rotate(45 60 6)"
        stroke="currentColor"
        strokeWidth="1"
      />
      <rect
        x="58.4"
        y="4.4"
        width="3.2"
        height="3.2"
        transform="rotate(45 60 6)"
        fill="currentColor"
      />
      <line
        x1="72"
        y1="6"
        x2="120"
        y2="6"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.55"
      />
    </svg>
  );
}
