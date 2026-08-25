// Política de trocas e devoluções — página institucional com ISR.
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getDb } from "@/db/client";
import { getSettingsMap } from "@/services/settings";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Trocas e devoluções",
  description:
    "Como trocar ou devolver um produto: direito de arrependimento de 7 dias, troca por defeito e passo a passo do reembolso.",
};

function settingText(map: Record<string, unknown>, key: string): string {
  const value = map[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : "[preencher nas Configurações]";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-base leading-relaxed text-zinc-700 dark:text-zinc-300">
        {children}
      </div>
    </section>
  );
}

export default async function ReturnsPage() {
  const s = await getSettingsMap(getDb(), [
    "store_name",
    "store_email",
    "store_whatsapp",
  ]);
  const storeName = settingText(s, "store_name");
  const email = settingText(s, "store_email");
  const whatsapp = settingText(s, "store_whatsapp");

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
        Trocas e devoluções
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
        Queremos que você fique feliz com a sua compra na {storeName}. Se algo
        não deu certo, aqui está tudo o que você precisa saber — de forma
        simples e sem pegadinhas.
      </p>

      <Section title="Me arrependi da compra. E agora?">
        <p>
          Comprou pela internet e mudou de ideia? Tudo bem. A lei garante a você
          o <strong>direito de arrependimento</strong>: até{" "}
          <strong>7 dias corridos</strong> após receber o produto, você pode
          desistir da compra sem precisar dar nenhum motivo (art. 49 do Código
          de Defesa do Consumidor).
        </p>
        <p>Funciona assim:</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Fale com a gente pelo WhatsApp ({whatsapp}) ou pelo e-mail ({email})
            dentro dos 7 dias, informando o número do pedido.
          </li>
          <li>
            Combinamos com você a forma de devolução do produto. O custo do
            envio de volta é por nossa conta.
          </li>
          <li>
            Devolva o produto, de preferência com a embalagem e os acessórios
            que o acompanham.
          </li>
          <li>
            Assim que o produto chegar, devolvemos <strong>todo</strong> o valor
            pago — produto e frete — em até 7 dias úteis, pelo mesmo meio em que
            você pagou (Pix, na maioria dos casos).
          </li>
        </ol>
      </Section>

      <Section title="O produto veio com defeito">
        <p>
          Se o produto apresentar defeito, você tem direito à solução garantida
          pelo Código de Defesa do Consumidor (art. 26): prazo de{" "}
          <strong>30 dias</strong> para reclamar de produtos não duráveis (como
          itens de consumo) e <strong>90 dias</strong> para produtos duráveis
          (como roupas, acessórios e objetos), contados a partir do recebimento
          — ou da data em que o defeito aparecer, quando não for visível de
          cara.
        </p>
        <p>
          Nesses casos, você escolhe entre: <strong>troca</strong> por um
          produto igual (ou equivalente, se preferir),{" "}
          <strong>devolução do valor pago</strong>, corrigido, ou{" "}
          <strong>abatimento proporcional do preço</strong>. O envio da troca ou
          devolução por defeito é sempre por nossa conta.
        </p>
      </Section>

      <Section title="Como iniciar uma troca ou devolução">
        <p>É só falar com a gente por um destes canais, com o número do pedido em mãos:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>WhatsApp:</strong> {whatsapp}
          </li>
          <li>
            <strong>E-mail:</strong> {email}
          </li>
        </ul>
        <p>
          Respondemos em até 2 dias úteis e conduzimos todo o processo com você,
          passo a passo. Nenhuma troca ou devolução é recusada dentro dos prazos
          e condições acima.
        </p>
      </Section>

      <Section title="Dicas para agilizar">
        <ul className="list-disc space-y-2 pl-5">
          <li>Guarde a embalagem até ter certeza de que vai ficar com o produto.</li>
          <li>
            Se possível, envie fotos do produto e do defeito na primeira
            mensagem — isso costuma resolver tudo mais rápido.
          </li>
          <li>Guarde o link de acompanhamento do seu pedido.</li>
        </ul>
      </Section>
    </main>
  );
}
