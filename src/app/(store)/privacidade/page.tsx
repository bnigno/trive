// Política de privacidade (LGPD) — página institucional com ISR.
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { getSettingsMap } from "@/services/settings";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Política de privacidade",
  description:
    "Quais dados coletamos, para quê, por quanto tempo e quais são os seus direitos segundo a LGPD.",
};

function settingText(map: Record<string, unknown>, key: string): string {
  const value = map[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : "[preencher nas Configurações]";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-12">
      <div aria-hidden className="h-px w-10 bg-gold-500" />
      <h2 className="mt-4 font-display text-heading font-semibold text-ink-900">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-ink-700">
        {children}
      </div>
    </section>
  );
}

export default async function PrivacyPage() {
  const s = await tryOrBuildFallback({}, () =>
    getSettingsMap(getDb(), [
    "store_name",
    "store_cnpj",
    "store_email",
    "store_whatsapp",
  ]),
  );
  const storeName = settingText(s, "store_name");
  const cnpj = settingText(s, "store_cnpj");
  const email = settingText(s, "store_email");
  const whatsapp = settingText(s, "store_whatsapp");

  return (
    <article className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="font-display text-title font-semibold tracking-tight text-ink-950">
        Política de privacidade
      </h1>
      <p className="mt-4 font-display text-xl leading-relaxed text-ink-700 italic">
        A {storeName} coleta apenas o necessário para entregar o seu pedido — e
        esta página explica, em português claro, o que é coletado, por quê e
        quais são os seus direitos, conforme a Lei Geral de Proteção de Dados
        (LGPD, Lei 13.709/2018).
      </p>

      <Section title="Quais dados coletamos">
        <p>Quando você faz um pedido, pedimos:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Nome completo</strong> — para identificar o pedido e a
            entrega;
          </li>
          <li>
            <strong>CPF (ou CNPJ)</strong> — exigido para a emissão da nota
            fiscal;
          </li>
          <li>
            <strong>Telefone/WhatsApp e e-mail</strong> — para combinar o
            pagamento e avisar sobre o andamento do pedido;
          </li>
          <li>
            <strong>Endereço de entrega</strong> — para enviar os produtos e
            calcular o frete.
          </li>
        </ul>
        <p>
          Não coletamos dados de cartão de crédito no site: o pagamento é
          combinado diretamente com você (via Pix, na maioria dos casos).
        </p>
      </Section>

      <Section title="Para que usamos os seus dados">
        <ul className="list-disc space-y-2 pl-5">
          <li>Processar, faturar e entregar o seu pedido;</li>
          <li>Falar com você sobre o pagamento e o andamento da entrega;</li>
          <li>Emitir a nota fiscal e cumprir obrigações fiscais;</li>
          <li>Atender pedidos de troca, devolução ou reembolso;</li>
          <li>
            Enviar novidades e ofertas pelo WhatsApp — <strong>somente</strong>{" "}
            se você autorizar (veja abaixo).
          </li>
        </ul>
        <p>Não vendemos nem alugamos seus dados a terceiros. Compartilhamos apenas o mínimo necessário com quem participa da entrega (transportadora/Correios) e com obrigações legais (nota fiscal).</p>
      </Section>

      <Section title="Novidades no WhatsApp: só com o seu sim">
        <p>
          Ao finalizar a compra você pode marcar (ou não) a opção de receber
          novidades pelo WhatsApp. Esse consentimento é sempre uma escolha sua e
          nunca vem marcado por padrão.
        </p>
        <p>
          Para parar de receber, basta responder <strong>SAIR</strong> a
          qualquer mensagem nossa — ou pedir pelo e-mail {email}. A saída vale
          na hora e não afeta em nada seus pedidos.
        </p>
      </Section>

      <Section title="Por quanto tempo guardamos">
        <p>
          Dados de pedidos e notas fiscais são guardados pelo prazo exigido pela
          legislação fiscal e de defesa do consumidor (em geral, 5 anos). Dados
          usados apenas para comunicação de ofertas são mantidos enquanto durar
          o seu consentimento — e apagados quando você pedir.
        </p>
      </Section>

      <Section title="Seus direitos">
        <p>A LGPD garante a você, a qualquer momento:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Saber quais dados seus nós temos e como são usados;</li>
          <li>Corrigir dados incompletos ou desatualizados;</li>
          <li>
            Pedir a exclusão dos dados que não precisamos mais guardar por
            obrigação legal;
          </li>
          <li>Revogar consentimentos (como o das mensagens de ofertas);</li>
          <li>Solicitar a portabilidade dos seus dados.</li>
        </ul>
        <p>
          Para exercer qualquer um desses direitos, é só falar com a gente —
          respondemos em até 15 dias.
        </p>
      </Section>

      <Section title="Segurança">
        <p>
          Seus dados ficam em ambiente protegido, com acesso restrito à equipe
          da loja. A página pública de acompanhamento do pedido não exibe nenhum
          dado pessoal — apenas os itens, os valores e o status da entrega.
        </p>
      </Section>

      <Section title="Quem responde pelos seus dados">
        <p>
          O controlador dos dados é <strong>{storeName}</strong>, CNPJ{" "}
          <strong>{cnpj}</strong>. Canal de contato para assuntos de
          privacidade: {email} ou WhatsApp {whatsapp}.
        </p>
        <p>
          Esta política pode ser atualizada de tempos em tempos; a versão
          publicada nesta página é sempre a vigente.
        </p>
      </Section>
    </article>
  );
}
