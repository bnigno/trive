import type { Metadata } from "next";
import Link from "next/link";

import { getFileStorage } from "@/adapters/storage";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { REDO_BLOCKED_LABELS } from "@/core/atelier/redo";
import { errorDetailLabel, interpretationFailedLabel } from "@/core/atelier/reply";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { formatCentsBRL } from "@/lib/money";
import { requireUser } from "@/services/auth";
import { listAtelierIntakes } from "@/services/atelier";
import { OwnerOnly } from "../../owner-only";
import { RedoIntakeForm } from "./redo-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Chegadas pelo WhatsApp" };

const STATUS_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  queued: { label: "Montando…", tone: "info" },
  done: { label: "Rascunho pronto", tone: "success" },
  failed: { label: "Deu errado", tone: "danger" },
};

// Chegadas pelo WhatsApp: cada envio da dona (fotos + recado), o que foi
// entendido, o que virou (rascunho, fornecedor, conta) e o que deu errado.
// Sem regra aqui: tudo vem de listAtelierIntakes; "Refazer" é uma action.
export default async function ChegadasPage() {
  await requireUser();
  const rows = await listAtelierIntakes(getDb(), { limit: 60 });
  const storage = getFileStorage();
  const failed = rows.filter((row) => row.status === "failed").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Chegadas pelo WhatsApp"
        subtitle={
          rows.length === 0
            ? "Cada foto + recado que você manda para o número da maison aparece aqui."
            : `${rows.length} ${rows.length === 1 ? "chegada" : "chegadas"}${failed > 0 ? ` · ${failed} ${failed === 1 ? "deu" : "deram"} errado` : ""}`
        }
        actions={
          <Link href="/admin/produtos" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            ← Produtos
          </Link>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nenhuma chegada ainda."
          hint="Do seu celular, mande as fotos da peça para o número da maison e depois um recado com o nome, cores, tamanhos e custo. A peça nasce em rascunho e aparece aqui."
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {rows.map((row) => {
            const status = STATUS_LABELS[row.status] ?? { label: row.status, tone: "neutral" as BadgeTone };
            const proposal = row.parsed?.proposal ?? null;
            const purchase = row.parsed?.purchase ?? null;
            return (
              <li key={row.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span className="text-zinc-500">{formatDateTimeSP(row.createdAt)}</span>
                      <span className="text-zinc-500">· {row.photosCount === 1 ? "1 foto" : `${row.photosCount} fotos`}</span>
                      <span className="text-zinc-500">· recado por {row.noteKind === "audio" ? "áudio" : row.noteKind === "caption" ? "legenda" : "texto"}</span>
                    </p>
                    <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">
                      {row.note ? `“${row.note.slice(0, 240)}${row.note.length > 240 ? "…" : ""}”` : <span className="text-zinc-500">(sem recado)</span>}
                    </p>
                  </div>
                  {row.product ? (
                    <Link href={`/admin/produtos/${row.product.id}`} className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                      {row.product.name}
                      {row.product.status === "archived" ? " (arquivado)" : row.product.status === "active" ? " (ativo)" : " (rascunho)"}
                    </Link>
                  ) : null}
                </div>

                {proposal ? (
                  <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
                    <div>
                      <dt className="inline text-zinc-500">Grade: </dt>
                      <dd className="inline">
                        {proposal.colors.length > 0 || proposal.sizes.length > 0
                          ? `${proposal.colors.join(", ") || "sem cor"} × ${proposal.sizes.join(", ") || "sem tamanho"}`
                          : "peça simples"}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-zinc-500">Quantidade: </dt>
                      <dd className="inline">
                        {proposal.quantityPerVariant !== null
                          ? `${proposal.quantityPerVariant} de cada (${proposal.totalQuantity ?? "?"} peças)`
                          : proposal.totalQuantity !== null
                            ? `${proposal.totalQuantity} peças`
                            : "não disse"}
                        {purchase ? (purchase.movements > 0 ? " — estoque lançado" : purchase.skipped ? ` — estoque não lançado (${purchase.skipped.replace(/_/g, " ")})` : "") : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-zinc-500">Custo: </dt>
                      <dd className="inline">
                        {proposal.unitCostCents !== null
                          ? `${formatCentsBRL(proposal.unitCostCents)} por peça`
                          : proposal.totalCostCents !== null
                            ? `${formatCentsBRL(proposal.totalCostCents)} no total`
                            : proposal.unconfirmedCostCents !== null
                              ? `${formatCentsBRL(proposal.unconfirmedCostCents)} (por peça ou o lote? confira)`
                              : "não disse"}
                        {row.parsed?.suggestedPriceCents ? ` · sugerido ${formatCentsBRL(row.parsed.suggestedPriceCents)}` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-zinc-500">Fornecedor: </dt>
                      <dd className="inline">
                        {row.supplier ? (
                          <Link href={`/admin/fornecedores/${row.supplier.id}`} className="underline">
                            {row.supplier.name}
                          </Link>
                        ) : (
                          (proposal.supplierName ?? "não disse")
                        )}
                        {row.payable ? (
                          <>
                            {" · "}
                            <Link href="/admin/financeiro" className="underline">
                              a pagar {formatCentsBRL(row.payable.amountCents)} ({row.payable.status === "pending" ? "pendente" : row.payable.status === "settled" ? "pago" : "cancelado"})
                            </Link>
                          </>
                        ) : null}
                      </dd>
                    </div>
                    {proposal.warnings.length > 0 ? (
                      <div className="sm:col-span-2 text-amber-800 dark:text-amber-300">Avisos: {proposal.warnings.join(" · ")}</div>
                    ) : null}
                  </dl>
                ) : row.parsed?.failed ? (
                  <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">
                    A inteligência não montou a grade ({interpretationFailedLabel(row.parsed.failed)}): a ficha nasceu simples — complete no painel.
                  </p>
                ) : null}

                {row.errorDetail ? <p className="mt-2 text-sm text-red-700 dark:text-red-300">{errorDetailLabel(row.errorDetail)}</p> : null}

                <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                  {row.cardPath ? (
                    <a href={storage.publicUrl(row.cardPath)} target="_blank" rel="noreferrer" className="text-zinc-600 underline dark:text-zinc-400">
                      Cartão enviado
                    </a>
                  ) : null}
                  {row.parsed?.usage ? (
                    <span className="text-xs text-zinc-500">
                      Inteligência: {row.parsed.model} · {(row.parsed.ms / 1000).toFixed(1)} s
                    </span>
                  ) : null}
                  <OwnerOnly>
                    {row.redo.ok ? (
                      <RedoIntakeForm intakeId={row.id} hasProduct={row.product !== null && row.product.status !== "archived"} />
                    ) : (
                      <span className="text-xs text-zinc-500">Refazer: {REDO_BLOCKED_LABELS[row.redo.reason]}</span>
                    )}
                  </OwnerOnly>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
