import type { Metadata } from "next";
import { count, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { requireOwner } from "@/services/auth";
import { discardDeadEvent, requeueDeadEvent } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Fila",
};

type DeadEvent = typeof outboxEvents.$inferSelect;

type QueueData = {
  counts: { pending: number; failed: number; dead: number };
  deadEvents: DeadEvent[];
};

async function loadQueue(): Promise<QueueData | null> {
  try {
    const db = getDb();
    const [statusRows, deadEvents] = await Promise.all([
      db
        .select({ status: outboxEvents.status, total: count() })
        .from(outboxEvents)
        .where(inArray(outboxEvents.status, ["pending", "failed", "dead"]))
        .groupBy(outboxEvents.status),
      db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.status, "dead"))
        .orderBy(desc(outboxEvents.createdAt))
        .limit(100),
    ]);

    const counts = { pending: 0, failed: 0, dead: 0 };
    for (const row of statusRows) {
      if (row.status === "pending") counts.pending = row.total;
      if (row.status === "failed") counts.failed = row.total;
      if (row.status === "dead") counts.dead = row.total;
    }
    return { counts, deadEvents };
  } catch {
    return null;
  }
}

const whenFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
        {value}
      </p>
    </div>
  );
}

export default async function QueuePage() {
  await requireOwner("fila");
  const data = await loadQueue();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Fila de eventos
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Eventos de saída (outbox) que esgotaram as tentativas.
        </p>
      </div>

      {data === null ? (
        <p className="max-w-xl rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Não foi possível consultar o banco de dados agora. Verifique a
          conexão (DATABASE_URL) e recarregue a página.
        </p>
      ) : (
        <>
          <div className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard label="Pendentes" value={data.counts.pending} />
            <StatCard label="Com falha" value={data.counts.failed} />
            <StatCard label="Mortos" value={data.counts.dead} />
          </div>

          {data.deadEvents.length === 0 ? (
            <p className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              Nenhum evento morto — tudo em dia.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
              <table className="w-full min-w-[56rem] border-collapse bg-white text-left text-sm dark:bg-zinc-900">
                <thead>
                  <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                    <th className="px-4 py-3 font-medium">Evento</th>
                    <th className="px-4 py-3 font-medium">Agregado</th>
                    <th className="px-4 py-3 font-medium">Tentativas</th>
                    <th className="px-4 py-3 font-medium">Último erro</th>
                    <th className="px-4 py-3 font-medium">Quando</th>
                    <th className="px-4 py-3 font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deadEvents.map((event) => (
                    <tr
                      key={event.id}
                      className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                        {event.eventType}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                        {event.aggregateType ? (
                          <>
                            {event.aggregateType}
                            {event.aggregateId ? (
                              <span className="ml-1 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                                {event.aggregateId.slice(0, 8)}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                        {event.attempts}/{event.maxAttempts}
                      </td>
                      <td
                        className="max-w-xs truncate px-4 py-3 text-zinc-600 dark:text-zinc-400"
                        title={event.lastError ?? undefined}
                      >
                        {event.lastError ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-zinc-600 dark:text-zinc-400">
                        {whenFormatter.format(event.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <div className="flex gap-2">
                          <form action={requeueDeadEvent}>
                            <input type="hidden" name="id" value={event.id} />
                            <button
                              type="submit"
                              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
                            >
                              Reprocessar
                            </button>
                          </form>
                          <form action={discardDeadEvent}>
                            <input type="hidden" name="id" value={event.id} />
                            <button
                              type="submit"
                              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                              Descartar
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
