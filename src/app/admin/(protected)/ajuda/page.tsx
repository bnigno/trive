import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { requireUser } from "@/services/auth";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ajuda",
};

/**
 * Runbook leigo: o "manual do que fazer quando algo der errado", escrito para
 * quem não é técnico. Versão markdown resumida em docs/runbook.md.
 */

const SECTIONS = [
  { id: "site-caiu", title: "O site caiu ou está estranho" },
  { id: "mensagem-nao-chegou", title: "Mensagem ou e-mail não chegou" },
  { id: "whatsapp-desconectou", title: "WhatsApp desconectou" },
  { id: "preco-nao-atualiza", title: "Preço não atualiza na loja" },
  { id: "aprovar-em-lote", title: "Aprovar preços em lote" },
  { id: "estoque-nao-bate", title: "Estoque não bate" },
  { id: "backup", title: "Backup e restauração" },
  { id: "custos", title: "Custos mensais e quando fazer upgrade" },
  { id: "quem-chamar", title: "Quem chamar" },
] as const;

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 className="border-b border-zinc-200 px-5 py-3 text-sm font-semibold text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
        {title}
      </h2>
      <div className="space-y-3 p-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {children}
      </div>
    </section>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="list-decimal space-y-2 pl-5 marker:font-semibold marker:text-zinc-500 dark:marker:text-zinc-400">
      {children}
    </ol>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[13px] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
      {children}
    </code>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-[13px] leading-relaxed text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200">
      {children}
    </pre>
  );
}

function AdminLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
    >
      {children}
    </Link>
  );
}

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
    >
      {children}
    </a>
  );
}

function Callout({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      {children}
    </div>
  );
}

export default async function AjudaPage() {
  await requireUser();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Ajuda"
        subtitle="O que fazer quando algo der errado — em linguagem de gente, sem tecniquês."
      />

      <nav className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          Nesta página
        </p>
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-indigo-600 underline underline-offset-2 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="site-caiu" title="O site caiu ou está estranho">
        <p>
          Respira: quase sempre dá para voltar tudo ao normal em poucos
          minutos, sem precisar de ninguém técnico.
        </p>
        <Steps>
          <li>
            Primeiro, confira se o problema é mesmo no site. Abra{" "}
            <ExternalLink href="https://trivemaison.com.br/api/health">
              trivemaison.com.br/api/health
            </ExternalLink>{" "}
            — é o &quot;check-up&quot; automático da loja. Se aparecer{" "}
            <Code>ok</Code>, o site e o banco estão de pé (o problema pode ser
            a sua internet).
          </li>
          <li>
            Veja se a Vercel (a empresa que hospeda o site) está com problema
            geral:{" "}
            <ExternalLink href="https://status.vercel.com">
              status.vercel.com
            </ExternalLink>
            . Se estiver, é só esperar — eles mesmos resolvem.
          </li>
          <li>
            Se o site quebrou logo depois de uma atualização, dá para voltar à
            versão anterior: entre em{" "}
            <ExternalLink href="https://vercel.com">vercel.com</ExternalLink>,
            abra o projeto, clique em <strong>Deployments</strong>, encontre a
            última versão que funcionava (a de antes da atual), clique nos três
            pontinhos e escolha <strong>Promote to Production</strong>. Em ~1
            minuto o site volta a ser a versão antiga.
          </li>
        </Steps>
        <Callout>
          Voltar a versão anterior não apaga nada: pedidos, clientes e estoque
          ficam no banco de dados, que é separado do site.
        </Callout>
      </Section>

      <Section id="mensagem-nao-chegou" title="Mensagem ou e-mail não chegou">
        <p>
          Toda mensagem de WhatsApp e todo e-mail passam por uma{" "}
          <strong>fila</strong>: o sistema tenta enviar e, se falhar (internet
          instável, serviço fora do ar), <strong>tenta de novo sozinho</strong>{" "}
          várias vezes, esperando um pouco mais entre cada tentativa. Ou seja:
          um atraso de alguns minutos é normal e se resolve sem você fazer
          nada.
        </p>
        <p>Se depois de um tempo a mensagem ainda não chegou:</p>
        <Steps>
          <li>
            Abra <AdminLink href="/admin/fila">Fila</AdminLink> aqui no painel.
          </li>
          <li>
            Se houver itens na lista de falhas definitivas, clique em{" "}
            <strong>Reprocessar</strong> — o sistema tenta enviar de novo na
            hora.
          </li>
          <li>
            Se continuar falhando, veja o motivo mostrado no item (por
            exemplo, WhatsApp desconectado — aí a solução está na seção{" "}
            <a
              href="#whatsapp-desconectou"
              className="font-medium text-indigo-600 underline underline-offset-2 dark:text-indigo-400"
            >
              WhatsApp desconectou
            </a>
            ).
          </li>
        </Steps>
      </Section>

      <Section id="whatsapp-desconectou" title="WhatsApp desconectou">
        <p>
          De vez em quando o WhatsApp pede para &quot;parear&quot; de novo — é
          como quando o WhatsApp Web do celular desloga. Nada foi perdido:{" "}
          <strong>as mensagens ficam guardadas na fila</strong> e são enviadas
          assim que a conexão volta.
        </p>
        <Steps>
          <li>
            Abra <AdminLink href="/admin/whatsapp">WhatsApp</AdminLink> aqui no
            painel.
          </li>
          <li>
            Siga as instruções para escanear o <strong>QR code</strong> com o
            celular da loja (WhatsApp → Aparelhos conectados → Conectar um
            aparelho).
          </li>
          <li>
            Depois de reconectar, confira a{" "}
            <AdminLink href="/admin/fila">Fila</AdminLink> e reprocesse o que
            tiver ficado pendente.
          </li>
        </Steps>
      </Section>

      <Section id="preco-nao-atualiza" title="Preço não atualiza na loja">
        <p>Dois motivos possíveis, ambos simples:</p>
        <Steps>
          <li>
            <strong>O preço ainda espera aprovação.</strong> Mudanças de preço
            relevantes não entram no ar sozinhas — elas aguardam o seu OK em{" "}
            <AdminLink href="/admin/precos/pendencias">
              Preços → Pendências
            </AdminLink>
            . Confira se há algo aguardando lá.
          </li>
          <li>
            <strong>A vitrine tem uma memória de 5 minutos.</strong> Para a
            loja carregar rápido, as páginas ficam &quot;prontas&quot; por até
            5 minutos (o chamado cache). Um preço recém-aprovado pode demorar
            esse tempinho para aparecer. Espere 5 minutos e recarregue a
            página — se aparecer, estava tudo certo.
          </li>
        </Steps>
      </Section>

      <Section id="aprovar-em-lote" title="Aprovar preços em lote">
        <p>
          Quando você recalcula preços (por mudança de custo ou de taxa), o
          sistema gera várias propostas de uma vez. Não precisa aprovar uma
          por uma:
        </p>
        <Steps>
          <li>
            Abra{" "}
            <AdminLink href="/admin/precos/pendencias">
              Preços → Pendências
            </AdminLink>
            .
          </li>
          <li>
            As propostas de um mesmo recálculo aparecem agrupadas como um{" "}
            <strong>lote</strong>. Revise os valores — a tela mostra o preço
            atual e o proposto, lado a lado.
          </li>
          <li>
            Clique em <strong>Aprovar lote</strong> para ativar todas de uma
            vez (ou <strong>Rejeitar lote</strong> informando o motivo, se
            algo estiver errado).
          </li>
        </Steps>
        <p>
          Lembre-se: depois de aprovar, a loja pode levar até 5 minutos para
          mostrar o preço novo (veja a seção anterior).
        </p>
      </Section>

      <Section id="estoque-nao-bate" title="Estoque não bate">
        <p>
          Se o número no sistema não bate com o que está na prateleira, a
          regra de ouro é: <strong>o histórico é a verdade</strong>. Cada
          entrada, venda e ajuste fica registrado com data e responsável —
          nada é apagado nem sobrescrito por fora.
        </p>
        <Steps>
          <li>
            Abra <AdminLink href="/admin/estoque">Estoque</AdminLink> e
            consulte o <strong>histórico de movimentações</strong> do produto:
            ele conta a história completa e quase sempre revela onde está a
            diferença (uma venda no balcão não registrada, uma troca, uma
            avaria).
          </li>
          <li>
            Conte fisicamente o que há na prateleira.
          </li>
          <li>
            Se a diferença for real, faça um <strong>ajuste de estoque</strong>{" "}
            informando o <strong>motivo</strong> (ele é obrigatório de
            propósito: daqui a seis meses você vai agradecer saber por que o
            número mudou).
          </li>
        </Steps>
        <Callout>
          Nunca &quot;conserte&quot; o estoque criando uma venda ou entrada
          falsa — use sempre o ajuste com motivo. É isso que mantém o
          histórico confiável.
        </Callout>
      </Section>

      <Section id="backup" title="Backup e restauração">
        <p>
          Todos os dias, de madrugada, o GitHub (onde fica o código do
          projeto) faz uma <strong>cópia de segurança completa do banco</strong>{" "}
          — pedidos, clientes, estoque, tudo — e guarda por 30 dias. Isso é o
          workflow <Code>Backup</Code> em{" "}
          <ExternalLink href="https://github.com/bnigno/trive/actions">
            github.com/bnigno/trive → Actions
          </ExternalLink>
          . Ele usa uma &quot;chave&quot; chamada <Code>DATABASE_URL</Code>{" "}
          cadastrada nos segredos do repositório — se essa chave mudar (por
          exemplo, ao trocar a senha do banco), o backup fica vermelho até
          alguém atualizá-la em Settings → Secrets and variables → Actions.
        </p>
        <p>
          <strong>Backup que nunca foi testado não é backup.</strong> A cada
          três meses, vale fazer o teste de restauração: baixar o backup mais
          recente e restaurá-lo em um banco de teste (nunca no de produção)
          para confirmar que ele funciona. Quem faz isso é o assistente (esta
          IA, no Claude Code) com o script preparado para isso:
        </p>
        <CodeBlock>
          {`# 1. Baixar o backup mais recente do GitHub
gh run download --name trive-backup

# 2. Restaurar no banco de TESTE (o script pede confirmação)
pnpm tsx scripts/restore-backup.ts trive-backup-AAAA-MM-DD.dump .env.local`}
        </CodeBlock>
        <p>
          O script confere para onde vai a restauração e, se o destino parecer
          o banco de produção, ele <strong>trava</strong> e só continua se a
          pessoa digitar uma confirmação por extenso — impossível restaurar em
          produção sem querer. O passo a passo completo está em{" "}
          <Code>docs/runbook.md</Code>.
        </p>
      </Section>

      <Section id="custos" title="Custos mensais e quando fazer upgrade">
        <p>
          Hoje a loja roda quase toda em planos gratuitos. O que se paga (ou
          se pagará) é isto:
        </p>
        <Table headers={["Serviço", "Para que serve", "Custo"]}>
          <Tr>
            <Td className="font-medium">Vercel Pro</Td>
            <Td>Hospedagem do site</Td>
            <Td>US$ 20/mês a partir do lançamento</Td>
          </Tr>
          <Tr>
            <Td className="font-medium">Z-API</Td>
            <Td>WhatsApp automático (quando sair do modo simulado)</Td>
            <Td>~R$ 100–150/mês</Td>
          </Tr>
          <Tr>
            <Td className="font-medium">Supabase, Inngest, Resend, GitHub</Td>
            <Td>Banco de dados, filas, e-mails, código e backups</Td>
            <Td>Grátis, por enquanto</Td>
          </Tr>
        </Table>
        <p>
          <strong>Quando fazer upgrade</strong> (antes disso, não gaste):
        </p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Mais de 1.000 pedidos por mês</strong> ou{" "}
            <strong>o primeiro susto com dados</strong> (banco pausado, backup
            que falhou de verdade) → contratar o{" "}
            <strong>Supabase Pro (US$ 25/mês)</strong>, que traz banco sem
            pausas e backups próprios da plataforma.
          </li>
          <li>
            <strong>Mais de 100 e-mails por dia</strong> (confirmações de
            pedido, avisos) → passar para o <strong>plano pago do Resend</strong>
            .
          </li>
        </ul>
      </Section>

      <Section id="quem-chamar" title="Quem chamar">
        <p>
          <strong>Primeiro socorro para qualquer coisa:</strong> abra o{" "}
          <strong>Claude Code</strong> no computador do projeto e descreva o
          problema com suas palavras (&quot;o site está fora do ar&quot;,
          &quot;o cliente diz que não recebeu o e-mail&quot;). Esta IA conhece
          o projeto inteiro, sabe onde mexer e explica o que está fazendo.
        </p>
        <p>Painéis dos serviços, caso precise entrar em algum:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <ExternalLink href="https://vercel.com">vercel.com</ExternalLink>{" "}
            — hospedagem do site (deploys, domínio)
          </li>
          <li>
            <ExternalLink href="https://supabase.com">
              supabase.com
            </ExternalLink>{" "}
            — banco de dados e login
          </li>
          <li>
            <ExternalLink href="https://app.inngest.com">
              app.inngest.com
            </ExternalLink>{" "}
            — fila de mensagens e tarefas automáticas
          </li>
          <li>
            <ExternalLink href="https://github.com/bnigno/trive">
              github.com/bnigno/trive
            </ExternalLink>{" "}
            — código do projeto e backups diários
          </li>
        </ul>
      </Section>
    </div>
  );
}
