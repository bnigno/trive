import type { Metadata } from "next";
import Link from "next/link";
import { AREA_LABELS, isAdminArea } from "@/core/auth/access";
import { requireUser } from "@/services/auth";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Área do proprietário",
};

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500";

const secondaryButtonClasses =
  "inline-flex items-center justify-center rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ de?: string }>;
}) {
  await requireUser();
  const { de } = await searchParams;
  // `de` vem da URL: só vira texto na tela depois de bater com a lista de
  // áreas conhecidas. Valor estranho cai no aviso genérico.
  const label = isAdminArea(de) ? AREA_LABELS[de] : null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader
        title="Esta área é do proprietário"
        subtitle={
          label
            ? `${label} fica reservada ao dono do negócio.`
            : "Esta parte do painel fica reservada ao dono do negócio."
        }
      />

      <Card>
        <div className="flex flex-col gap-4 text-sm text-zinc-600 dark:text-zinc-300">
          <p>
            Nada deu errado e você não fez nada de errado: algumas partes do
            painel guardam custos, margens, contas e configurações, e ficam só
            com o proprietário.
          </p>
          <p>
            Sua conta continua normal no restante — pedidos, clientes, produtos,
            estoque e conversas do WhatsApp seguem disponíveis no menu ao lado.
          </p>
          <p>
            Se você precisa mesmo entrar aqui para fazer seu trabalho, fale com
            o proprietário: ele pode liberar o acesso ou resolver junto com
            você.
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Link href="/admin" className={primaryButtonClasses}>
              Voltar para o início
            </Link>
            <Link href="/admin/pedidos" className={secondaryButtonClasses}>
              Ver pedidos
            </Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
