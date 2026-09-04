// Política de privacidade (LGPD) — página institucional com ISR.
import type { Metadata } from "next";

import {
  LegalArticle,
  LegalSection,
} from "@/components/store/legal/legal-article";
import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { describeContact, settingText } from "@/lib/settings-text";
import { getSettingsMap } from "@/services/settings";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Política de privacidade",
  description:
    "Quais dados coletamos, para quê, por quanto tempo e quais são os seus direitos segundo a LGPD.",
};

const TOC = [
  { id: "dados", title: "Quais dados coletamos" },
  { id: "uso", title: "Para que usamos os seus dados" },
  { id: "whatsapp", title: "Novidades no WhatsApp: só com o seu sim" },
  { id: "prazo", title: "Por quanto tempo guardamos" },
  { id: "direitos", title: "Seus direitos" },
  { id: "seguranca", title: "Segurança" },
  { id: "controlador", title: "Quem responde pelos seus dados" },
];

export default async function PrivacyPage() {
  const s = await tryOrBuildFallback({}, () =>
    getSettingsMap(getDb(), [
      "store_name",
      "store_cnpj",
      "store_email",
      "store_whatsapp",
    ]),
  );
  const storeName = settingText(s, "store_name", "a maison");
  const cnpj = settingText(s, "store_cnpj");
  const email = settingText(s, "store_email");
  const whatsapp = settingText(s, "store_whatsapp");
  const hasStoreData = Boolean(cnpj || email || whatsapp);
  const contact = describeContact(whatsapp, email);

  return (
    <LegalArticle
      eyebrow="Seus dados, com cuidado"
      title="Política de privacidade"
      lede={
        <>
          A {storeName} coleta apenas o necessário para entregar o seu pedido —
          e esta página explica, em português claro, o que é coletado, por quê
          e quais são os seus direitos, conforme a Lei Geral de Proteção de
          Dados (LGPD, Lei 13.709/2018).
        </>
      }
      toc={TOC}
    >
      <LegalSection id="dados" number="01" title="Quais dados coletamos">
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
      </LegalSection>

      <LegalSection id="uso" number="02" title="Para que usamos os seus dados">
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
        <p>
          Não vendemos nem alugamos seus dados a terceiros. Compartilhamos
          apenas o mínimo necessário com quem participa da entrega
          (transportadora/Correios) e com obrigações legais (nota fiscal).
        </p>
      </LegalSection>

      <LegalSection
        id="whatsapp"
        number="03"
        title="Novidades no WhatsApp: só com o seu sim"
      >
        <p>
          Ao finalizar a compra você pode marcar (ou não) a opção de receber
          novidades pelo WhatsApp. Esse consentimento é sempre uma escolha sua e
          nunca vem marcado por padrão.
        </p>
        <p>
          Para parar de receber, basta responder <strong>SAIR</strong> a
          qualquer mensagem nossa
          {email ? <> — ou pedir pelo e-mail {email}</> : null}. A saída vale
          na hora e não afeta em nada seus pedidos.
        </p>
      </LegalSection>

      <LegalSection id="prazo" number="04" title="Por quanto tempo guardamos">
        <p>
          Dados de pedidos e notas fiscais são guardados pelo prazo exigido pela
          legislação fiscal e de defesa do consumidor (em geral, 5 anos). Dados
          usados apenas para comunicação de ofertas são mantidos enquanto durar
          o seu consentimento — e apagados quando você pedir.
        </p>
      </LegalSection>

      <LegalSection id="direitos" number="05" title="Seus direitos">
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
      </LegalSection>

      <LegalSection id="seguranca" number="06" title="Segurança">
        <p>
          Seus dados ficam em ambiente protegido, com acesso restrito à equipe
          da loja. A página pública de acompanhamento do pedido não exibe nenhum
          dado pessoal — apenas os itens, os valores e o status da entrega.
        </p>
      </LegalSection>

      <LegalSection
        id="controlador"
        number="07"
        title="Quem responde pelos seus dados"
      >
        <p>
          O controlador dos dados é <strong>{storeName}</strong>
          {cnpj ? (
            <>
              , CNPJ <strong>{cnpj}</strong>
            </>
          ) : null}
          . Canal de contato para assuntos de privacidade: fale com a gente{" "}
          {contact}.
          {hasStoreData && !cnpj
            ? " Os dados completos da maison estão no rodapé."
            : null}
        </p>
        <p>
          Esta política pode ser atualizada de tempos em tempos; a versão
          publicada nesta página é sempre a vigente.
        </p>
      </LegalSection>
    </LegalArticle>
  );
}
