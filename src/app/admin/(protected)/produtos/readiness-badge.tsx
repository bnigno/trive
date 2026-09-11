import Link from "next/link";
import type { ProductReadiness, ReadinessIssue } from "@/core/catalog/readiness";
import { Badge, type BadgeTone } from "@/components/ui/badge";

const LEVEL_TONES: Record<ProductReadiness["level"], BadgeTone> = {
  ready: "success",
  almost: "warning",
  blocked: "danger",
  archived: "neutral",
};

/** Para onde o toque no motivo leva: o campo que falta, na tela certa. */
export function readinessIssueHref(productId: string, issue: ReadinessIssue): string {
  if (issue.code === "price_pending") return "/admin/precos/pendencias";
  if (issue.code === "no_price") return `/admin/precos/calculadora?product=${productId}`;
  if (issue.anchor === "categorias") return "/admin/produtos#categorias";
  const query = issue.focus ? `?foco=${issue.focus}` : "";
  return `/admin/produtos/${productId}${query}#${issue.anchor}`;
}

export function ReadinessBadge({
  productId,
  readiness,
}: {
  productId: string;
  readiness: ProductReadiness | undefined;
}) {
  if (!readiness) return <Badge tone="neutral">—</Badge>;
  if (readiness.level === "ready") return <Badge tone="success">Pronta</Badge>;
  const issue = readiness.primaryIssue;
  if (!issue) return <Badge tone={LEVEL_TONES[readiness.level]}>—</Badge>;
  const extra = readiness.issues.length - 1;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Link href={readinessIssueHref(productId, issue)} className="hover:underline">
        <Badge tone={LEVEL_TONES[readiness.level]}>{issue.label}</Badge>
      </Link>
      {extra > 0 ? (
        <Link
          href={`/admin/produtos/${productId}`}
          className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
        >
          +{extra}
        </Link>
      ) : null}
    </span>
  );
}
