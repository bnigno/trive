import { Badge } from "@/components/ui/badge";

export function LowStockBadge({
  available,
  threshold,
}: {
  available: number;
  threshold: number;
}) {
  if (available <= 0) {
    return <Badge tone="danger">Esgotado</Badge>;
  }
  if (available <= threshold) {
    return <Badge tone="warning">Estoque baixo</Badge>;
  }
  return null;
}
