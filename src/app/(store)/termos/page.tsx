// Termos de uso e condições de compra — página institucional com ISR.
// Identificação da loja conforme o Decreto 7.962/2013 (Lei do E-commerce).
// Dados que o dono ainda não preencheu não viram frase: só o que existe.
import type { Metadata } from "next";
import Link from "next/link";

import {
  LegalArticle,
  LegalSection,
} from "@/components/store/legal/legal-article";
import { linkGold } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { describeContact, settingText } from "@/lib/settings-text";
import { getSettingsMap } from "@/services/settings";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Termos de uso",
  description:
    "Condições de compra da loja: identificação, como o pedido funciona, preços, entrega e responsabilidades.",
};

const TOC = [
  { id: "quem-somos", title: "Quem somos" },
  { id: "como-funciona", title: "Como a compra funciona" },
  { id: "precos", title: "Preços e disponibilidade" },
  { id: "entrega", title: "Entrega" },
  { id: "trocas", title: "Trocas, devoluções e arrependimento" },
  { id: "responsabilidades", title: "Responsabilidades" },
  { id: "duvidas", title: "Dúvidas" },
];

export default async function TermsPage() {
  const s = await tryOrBuildFallback({}, () =>
    getSettingsMap(getDb(), [
      "store_name",
      "store_cnpj",
      "store_address",
      "store_email",
      "store_whatsapp",
    ]),
  );
  const storeName = settingText(s, "store_name", "a maison");
  const cnpj = settingText(s, "store_cnpj");
  const address = settingText(s, "store_address");
  const email = settingText(s, "store_email");
  const whatsapp = settingText(s, "store_whatsapp");
  const hasStoreData = Boolean(cnpj || address || email || whatsapp);
  const contact = describeContact(whatsapp, email);

  return (
    <LegalArticle
      eyebrow="A maison, por escrito"
      title="Termos de uso"
      lede={
        <>
          Estas são as condições de compra da {storeName}, escritas para serem
          entendidas — não para confundir. Ao fazer um pedido, você concorda
          com o que está descrito aqui.
        </>
      }
      toc={TOC}
    >
      <LegalSection id="quem-somos" number="01" title="Quem somos">
        <p>
          Esta loja é operada por <strong>{storeName}</strong>
          {cnpj ? (
            <>
              , CNPJ <strong>{cnpj}</strong>
            </>
          ) : null}
          {address ? (
            <>
              , com endereço em <strong>{address}</strong>
            </>
          ) : null}{" "}
          — informações publicadas em cumprimento ao Decreto 7.962/2013, que
          regula o comércio eletrônico no Brasil.
          {hasStoreData && !(cnpj && address)
            ? " Os dados completos da maison estão no rodapé."
            : null}
        </p>
        <p>Fale com a gente {contact}.</p>
      </LegalSection>

      <LegalSection id="como-funciona" number="02" title="Como a compra funciona">
        <p>Nossa loja trabalha com pagamento combinado, sem cobrança automática:</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Você faz o pedido</strong> pelo site, informando seus dados
            e o endereço de entrega.
          </li>
          <li>
            <strong>Os produtos ficam reservados por 2 horas</strong> para você
            — nesse período, ninguém mais pode comprá-los.
          </li>
          <li>
            <strong>Combinamos o pagamento pelo WhatsApp</strong>, normalmente
            via Pix. Nada é cobrado automaticamente no site.
          </li>
          <li>
            <strong>Pagamento confirmado, preparamos e enviamos</strong> o seu
            pedido, e você acompanha tudo pelo link que enviamos.
          </li>
        </ol>
        <p>
          Se o pagamento não for confirmado dentro do prazo da reserva, o pedido
          é cancelado automaticamente e os produtos voltam para a loja — sem
          nenhuma cobrança. Você pode refazer o pedido quando quiser.
        </p>
      </LegalSection>

      <LegalSection id="precos" number="03" title="Preços e disponibilidade">
        <p>
          Os preços exibidos na loja valem para o momento da compra e já são o
          valor final do produto — o frete é mostrado separadamente antes de
          você confirmar o pedido. Se algum preço mudar entre o carrinho e a
          confirmação, avisamos e pedimos que você revise antes de concluir:
          nunca cobramos um valor diferente do que você viu.
        </p>
        <p>
          O estoque é limitado. Em caso raro de um produto esgotar entre o
          pedido e a confirmação, avisamos imediatamente e devolvemos qualquer
          valor pago.
        </p>
      </LegalSection>

      <LegalSection id="entrega" number="04" title="Entrega">
        <p>
          O prazo e o custo de entrega são calculados pelo CEP e mostrados antes
          da confirmação do pedido. O prazo começa a contar a partir da
          confirmação do pagamento. Quando o pedido for enviado, você recebe o
          código de rastreio na página de acompanhamento.
        </p>
        <p>
          Se o endereço informado estiver incorreto ou incompleto e o pedido
          voltar para a gente, combinamos um novo envio (o custo do reenvio pode
          ser cobrado) ou o reembolso do valor dos produtos.
        </p>
      </LegalSection>

      <LegalSection
        id="trocas"
        number="05"
        title="Trocas, devoluções e arrependimento"
      >
        <p>
          Você tem 7 dias corridos após o recebimento para desistir da compra
          (art. 49 do CDC), além das garantias legais contra defeitos. Os
          detalhes e o passo a passo estão na nossa página de{" "}
          <Link href="/trocas-e-devolucoes" className={linkGold}>
            trocas e devoluções
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="responsabilidades" number="06" title="Responsabilidades">
        <p>
          Nós respondemos pela qualidade dos produtos vendidos, pela veracidade
          das informações da loja e pelo cumprimento dos prazos combinados. Você
          é responsável pela exatidão dos dados informados no pedido (nome,
          documento, contato e endereço de entrega).
        </p>
        <p>
          Este site é de uso pessoal para compras. Não é permitido utilizá-lo
          para fins ilícitos, tentar acessar áreas restritas ou copiar seu
          conteúdo para uso comercial sem autorização.
        </p>
      </LegalSection>

      <LegalSection id="duvidas" number="07" title="Dúvidas">
        <p>
          Qualquer dúvida sobre estes termos, é só falar com a gente {contact}.
          Estes termos podem ser atualizados de tempos em tempos; a versão
          publicada nesta página é sempre a que vale.
        </p>
      </LegalSection>
    </LegalArticle>
  );
}
