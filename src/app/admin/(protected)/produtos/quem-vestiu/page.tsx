import type { Metadata } from "next";
import Link from "next/link";

import { getFileStorage } from "@/adapters/storage";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { formatDateTimeSP } from "@/emails/templates";
import { requireOwner } from "@/services/auth";
import { listPendingLooks, listPublicLooks, listRecentLooks, type CustomerLookRow } from "@/services/customer-looks";
import { ApproveRejectForms, RevokeForm } from "./look-forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Quem já vestiu" };

const CARD_GRACE_MS = 10 * 60_000;

function stateOf(row: CustomerLookRow, now: Date): { label: string; tone: BadgeTone } {
  if (row.revokedAt) return { label: row.revokedBy === "owner" ? "Retirada por você" : row.revokedBy === "forget" ? "Retirada (esqueceu a cartela)" : "Retirada pela cliente", tone: "neutral" };
  if (row.isPublic) return { label: "Na vitrine", tone: "success" };
  if (row.rejectedAt) return { label: "Recusada", tone: "neutral" };
  if (row.consentAnswer === "sim") return { label: "Aguardando você", tone: "warning" };
  if (row.consentAnswer === "nao") return { label: "Ela preferiu não mostrar", tone: "neutral" };
  if (!row.photoPath) {
    return now.getTime() - row.createdAt.getTime() < CARD_GRACE_MS ? { label: "Montando o cartão…", tone: "info" } : { label: "Foto não baixou — veja a Fila", tone: "danger" };
  }
  return { label: "Aguardando a resposta dela", tone: "info" };
}

// Quem já vestiu: as fotos das clientes com as peças. A dona aprova (só as
// que a cliente autorizou), recusa ou retira. Sem regra aqui: tudo vem dos
// services; foto de cliente é dado pessoal — a página inteira é do dono.
export default async function QuemVestiuPage() {
  await requireOwner("produtos");
  const db = getDb();
  const [pending, published, recent] = await Promise.all([listPendingLooks(db), listPublicLooks(db), listRecentLooks(db, { limit: 200 })]);
  const storage = getFileStorage();
  const now = new Date();
  const shown = new Set([...pending, ...published].map((row) => row.id));
  const others = recent.filter((row) => !shown.has(row.id));

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

      {published.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Na vitrine ({published.length})</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {published.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-900 dark:bg-zinc-950">
                <LookPhoto row={row} url={row.photoPath ? storage.publicUrl(row.photoPath) : null} />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="success">Na vitrine</Badge>
                  {row.approvedAt ? <span className="text-xs text-zinc-500">desde {formatDateTimeSP(row.approvedAt)}</span> : null}
                </div>
                <LookMeta row={row} />
                <RevokeForm lookId={row.id} productSlug={row.productSlug} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {others.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Outras fotos recentes</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {others.map((row) => {
              const state = stateOf(row, now);
              return (
                <li key={row.id} className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                  <LookPhoto row={row} url={row.photoPath ? storage.publicUrl(row.photoPath) : null} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <span className="text-xs text-zinc-500">{formatDateTimeSP(row.createdAt)}</span>
                  </div>
                  <LookMeta row={row} />
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
    return <div className="flex aspect-[3/4] items-center justify-center rounded-md bg-zinc-100 text-xs text-zinc-500 dark:bg-zinc-900">{row.revokedAt ? "foto apagada" : "sem foto"}</div>;
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
