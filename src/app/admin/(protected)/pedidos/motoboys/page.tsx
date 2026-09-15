import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { listCouriers } from "@/services/couriers";

import { toggleCourierAction } from "./actions";
import { CourierCreateForm, CourierEditForm } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Motoboys",
};

// Motoboys: quem faz as saídas. Nome + WhatsApp (o link da saída vai para
// cá); desativar tira da lista da Rota do dia sem apagar o histórico.
export default async function MotoboysPage() {
  await requireUser();
  const couriers = await listCouriers(getDb(), { includeInactive: true });
  const active = couriers.filter((c) => c.isActive);
  const inactive = couriers.filter((c) => !c.isActive);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Motoboys"
        subtitle="Quem faz as saídas. Na Rota do dia você escolhe o motoboy, marca os pedidos e ele recebe o link no WhatsApp."
        actions={
          <Link href="/admin/pedidos/rota" className="text-sm text-zinc-600 hover:underline dark:text-zinc-400">
            ← Rota do dia
          </Link>
        }
      />

      <Card title="Novo motoboy">
        <CourierCreateForm />
      </Card>

      {couriers.length === 0 ? (
        <EmptyState title="Nenhum motoboy cadastrado." hint="Cadastre pelo menos um para montar a primeira saída com GPS." />
      ) : null}

      {active.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-700 uppercase dark:text-zinc-300">
            Ativos <span className="font-normal text-zinc-500">· {active.length}</span>
          </h2>
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {active.map((courier) => (
              <li key={courier.id} className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <CourierEditForm courierId={courier.id} name={courier.name} phone={courier.phoneE164} />
                <form action={toggleCourierAction} className="flex justify-end">
                  <input type="hidden" name="courierId" value={courier.id} />
                  <input type="hidden" name="isActive" value="false" />
                  <Button type="submit" size="sm" variant="ghost">
                    Desativar
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {inactive.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
            Desativados <span className="font-normal">· {inactive.length}</span>
          </h2>
          <ul className="flex flex-col gap-2">
            {inactive.map((courier) => (
              <li key={courier.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
                <span className="text-zinc-700 dark:text-zinc-300">
                  {courier.name} <span className="text-zinc-500">· {courier.phoneE164}</span> <Badge tone="neutral">desativado</Badge>
                </span>
                <form action={toggleCourierAction}>
                  <input type="hidden" name="courierId" value={courier.id} />
                  <input type="hidden" name="isActive" value="true" />
                  <Button type="submit" size="sm" variant="outline">
                    Reativar
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
