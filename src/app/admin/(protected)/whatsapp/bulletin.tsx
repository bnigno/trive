// Boletim da Lia: o que deu errado e quem ficou esperando.
//
// Em 04/10/2026 a Lia ficou desligada 8 dias sem ninguém notar — 277 mensagens
// encaminhadas, três clientes sem resposta de ninguém. Esta tela existe para
// que a próxima falha apareça em horas.
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { formatDateTimeSP } from "@/emails/templates";
import type { LiaBulletin } from "@/services/wa-insights";

function plural(n: number, um: string, muitos: string): string {
  return n === 1 ? um : muitos;
}

/** Faixa vermelha no topo: a vendedora não está respondendo ninguém. */
export function MutedBanner({
  bulletin,
  sellerName,
}: {
  bulletin: LiaBulletin;
  sellerName: string;
}) {
  if (!bulletin.muted) return null;
  const { since, days: dias, forwardedSince } = bulletin.muted;
  return (
    <div
      role="alert"
      className="rounded-lg border-2 border-red-400 bg-red-50 px-5 py-4 dark:border-red-800 dark:bg-red-950"
    >
      <p className="text-base font-semibold text-red-800 dark:text-red-200">
        A {sellerName} está desligada
        {dias !== null ? ` há ${dias} ${plural(dias, "dia", "dias")}` : ""} — ninguém
        está sendo atendido por ela.
      </p>
      <p className="mt-1 text-sm text-red-700 dark:text-red-300">
        {since ? `Desde ${formatDateTimeSP(since)}. ` : ""}
        {forwardedSince > 0
          ? `${forwardedSince} ${plural(forwardedSince, "mensagem foi encaminhada", "mensagens foram encaminhadas")} para o seu WhatsApp nesse período — cada uma precisa de uma resposta sua.`
          : "As mensagens das clientes estão sendo encaminhadas para o seu WhatsApp."}
      </p>
      <p className="mt-2 text-sm text-red-700 dark:text-red-300">
        Para voltar ao normal, ligue a {sellerName} no card{" "}
        <strong>Ligar e desligar</strong>, mais abaixo nesta página.
      </p>
    </div>
  );
}

/** Quem está esperando e o que deu errado nos turnos. */
export function LiaBulletinCard({
  bulletin,
  sellerName,
}: {
  bulletin: LiaBulletin;
  sellerName: string;
}) {
  const { waiting } = bulletin;
  const problemas = [
    { n: bulletin.turnsWithoutReply, label: "turnos sem resposta nenhuma", dica: "a cliente ficou no vácuo" },
    { n: bulletin.promisedHumanWithoutHandoff, label: "prometeu você e não transferiu", dica: "a conversa não chegou até você" },
    { n: bulletin.assertedWithoutTool, label: "afirmou sem conferir", dica: "falou preço, estoque ou prazo de memória" },
  ].filter((item) => item.n > 0);

  return (
    <Card title={`Boletim da ${sellerName}`}>
      <div className="flex flex-col gap-5">
        <section>
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Clientes esperando resposta
          </h3>
          {waiting.length === 0 ? (
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Nenhuma — toda cliente que escreveu já teve resposta. 🤎
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                A última palavra foi delas e ninguém respondeu depois.
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {waiting.map((cliente) => (
                  <li key={cliente.conversationId}>
                    <Link
                      href={`/admin/whatsapp/conversas?c=${cliente.conversationId}`}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span
                        className={
                          cliente.hoursWaiting >= 24
                            ? "shrink-0 text-sm font-semibold text-red-700 dark:text-red-400"
                            : "shrink-0 text-sm font-semibold text-amber-700 dark:text-amber-400"
                        }
                      >
                        {cliente.hoursWaiting >= 48
                          ? `${Math.floor(cliente.hoursWaiting / 24)} dias`
                          : `${cliente.hoursWaiting}h`}
                      </span>
                      <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {cliente.displayName ?? cliente.phoneE164}
                      </span>
                      <span className="min-w-0 text-sm text-zinc-500 dark:text-zinc-400">
                        “{cliente.preview}”
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {problemas.length > 0 ? (
          <section className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              Nos últimos {bulletin.windowDays} dias
            </h3>
            <ul className="mt-2 flex flex-col gap-1.5">
              {problemas.map((item) => (
                <li key={item.label} className="text-sm text-zinc-600 dark:text-zinc-400">
                  <strong className="text-zinc-900 dark:text-zinc-100">{item.n}</strong>{" "}
                  {item.label} —{" "}
                  <span className="text-zinc-500 dark:text-zinc-500">{item.dica}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Card>
  );
}
