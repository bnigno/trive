import type { Metadata } from "next";
import Link from "next/link";
import { count, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { requireUser } from "@/services/auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
};

async function getDeadCount(): Promise<number | null> {
  try {
    const db = getDb();
    const [row] = await db
      .select({ total: count() })
      .from(outboxEvents)
      .where(eq(outboxEvents.status, "dead"));
    return row?.total ?? 0;
  } catch {
    // Sem banco em dev a página continua funcionando, só sem o número.
    return null;
  }
}

export default async function AdminDashboardPage() {
  const user = await requireUser();
  const deadCount = await getDeadCount();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Olá, {user.fullName ?? user.email}
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Visão geral da operação.
        </p>
      </div>

      <div className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Pedidos hoje
          </p>
          <p className="mt-2 text-3xl font-semibold text-zinc-900 dark:text-zinc-100">
            —
          </p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            Disponível quando o módulo de pedidos existir.
          </p>
        </div>

        <Link
          href="/admin/fila"
          className="rounded-lg border border-zinc-200 bg-white p-5 transition-colors hover:border-indigo-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
        >
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
            Fila — eventos mortos
          </p>
          <p
            className={`mt-2 text-3xl font-semibold ${
              deadCount ? "text-red-600 dark:text-red-400" : "text-zinc-900 dark:text-zinc-100"
            }`}
          >
            {deadCount ?? "—"}
          </p>
          <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
            {deadCount === null
              ? "Banco indisponível no momento."
              : "Ver detalhes na Fila."}
          </p>
        </Link>
      </div>
    </div>
  );
}
