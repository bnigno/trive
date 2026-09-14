import type { Metadata } from "next";
import Link from "next/link";

import { getFileStorage } from "@/adapters/storage";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { requireOwner } from "@/services/auth";
import { listPendingLooks, listRecentLooks, type CustomerLookRow } from "@/services/customer-looks";
import { ApproveRejectForms, RevokeForm } from "./look-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quem já vestiu" };

function stateOf(row: CustomerLookRow): { label: string; tone: BadgeTone } {
  if (row.revokedAt) return { label: row.revokedBy === "owner" ? "Retirada por você" : row.revokedBy === "forget" ? "Retirada (esqueceu a cartela)" : "Retirada pela cliente", tone: "neutral" };
  if (row.isPublic) return { label: "Na vitrine", tone: "success" };
  if (row.rejectedAt) return { label: "Recusada", tone: "neutral" };
  if (row.consentAnswer === "sim") return { label: "Aguardando você", tone: "warning" };
  if (row.consentAnswer === "nao") return { label: "Ela preferiu não mostrar", tone: "neutral" };
  if (!row.photoPath) return { label: "Foto não baixou", tone: "danger" };
  return { label: "Aguardando a resposta dela", tone: "info" };
}

// Quem já vestiu: as fotos das clientes com as peças. A dona aprova (só as
// que a cliente autorizou), recusa ou retira. Sem regra aqui: tudo vem dos
// services; foto de cliente é dado pessoal — a página inteira é do dono.
export default async function QuemVestiuPage() {
  await requireOwner("produtos");
  const db = getDb();
  const [pending, recent] = await Promise.all([listPendingLooks(db), listRecentLooks(db, { limit: 60 })]);
  const storage = getFileStorage();
  const pendingIds = new Set(pending.map((row) => row.id));
  const others = recent.filter((row) => !pendingIds.has(row.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quem já vestiu"
        subtitle={pending.length === 0 ? "Fotos das clientes usando as peças, com o consentimento delas." : `${pending.length} ${pending.length === 1 ? "foto aguardando" : "fotos aguardando"} a sua aprovação`}
        actions={
          <Link href="/admin/produtos" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            ← Produtos
          </Link>
        }
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Aguardando você</h2>
        {pending.length === 0 ? (
          <EmptyState
            title="Nenhuma foto aguardando."
            hint="Quando a cliente manda uma foto dela usando a peça, a Lia guarda, ela recebe o cartão “Ana veste …” e a pergunta se pode aparecer na página. As que ela autorizar chegam aqui."
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pending.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-900 dark:bg-zinc-950">
                <LookPhoto row={row} url={row.photoPath ? storage.publicUrl(row.photoPath) : null} />
                <LookMeta row={row} />
                <ApproveRejectForms lookId={row.id} productSlug={row.productSlug} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {others.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Todas as fotos</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((row) => {
              const state = stateOf(row);
              return (
                <li key={row.id} className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <LookPhoto row={row} url={row.photoPath ? storage.publicUrl(row.photoPath) : null} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <span className="text-xs text-zinc-500">{formatDateTimeSP(row.createdAt)}</span>
                  </div>
                  <LookMeta row={row} />
                  {row.isPublic ? <RevokeForm lookId={row.id} productSlug={row.productSlug} /> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function LookPhoto({ row, url }: { row: CustomerLookRow; url: string | null }) {
  if (!url) {
    return <div className="flex aspect-[3/4] items-center justify-center rounded-md bg-zinc-100 text-xs text-zinc-500 dark:bg-zinc-900">sem foto</div>;
  }
  return <img src={url} alt={`${row.displayName} veste ${row.productName}`} className="aspect-[3/4] w-full rounded-md object-cover" />;
}

function LookMeta({ row }: { row: CustomerLookRow }) {
  return (
    <div className="text-sm">
      <p className="font-medium text-zinc-900 dark:text-zinc-100">
        {row.displayName} veste{" "}
        <Link href={`/admin/produtos/${row.productId}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
          {row.productName}
        </Link>
      </p>
      <p className="text-xs text-zinc-500">
        {row.customerName ?? row.phoneE164}
        {row.orderId ? (
          <>
            {" · "}
            <Link href={`/admin/pedidos/${row.orderId}`} className="hover:underline">
              pedido
            </Link>
          </>
        ) : (
          " · sem pedido com essa peça — confira antes de aprovar"
        )}
        {row.consentAt ? ` · autorizou em ${formatDateTimeSP(row.consentAt)}` : ""}
      </p>
    </div>
  );
}
