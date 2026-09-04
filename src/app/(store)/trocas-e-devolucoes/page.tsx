// Política de trocas e devoluções — página institucional com ISR.
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
  title: "Trocas e devoluções",
  description:
    "Como trocar ou devolver um produto: direito de arrependimento de 7 dias, troca por defeito e passo a passo do reembolso.",
};

const TOC = [
  { id: "arrependimento", title: "Me arrependi da compra. E agora?" },
  { id: "defeito", title: "O produto veio com defeito" },
  { id: "como-iniciar", title: "Como iniciar uma troca ou devolução" },
  { id: "dicas", title: "Dicas para agilizar" },
];

export default async function ReturnsPage() {
  const s = await tryOrBuildFallback({}, () =>
    getSettingsMap(getDb(), ["store_name", "store_email", "store_whatsapp"]),
  );
  const storeName = settingText(s, "store_name", "a maison");
  const email = settingText(s, "store_email");
  const whatsapp = settingText(s, "store_whatsapp");
  const contact = describeContact(whatsapp, email);

  return (
    <LegalArticle
      eyebrow="Se algo não ficou perfeito"
      title="Trocas e devoluções"
      lede={
        <>
          Queremos que você fique feliz com a sua compra na {storeName}. Se algo
          não deu certo, aqui está tudo o que você precisa saber — de forma
          simples e sem pegadinhas.
        </>
      }
      toc={TOC}
    >
      <LegalSection
        id="arrependimento"
        number="01"
        title="Me arrependi da compra. E agora?"
      >
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
            Fale com a gente {contact} dentro dos 7 dias, informando o número
            do pedido.
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
      </LegalSection>

      <LegalSection id="defeito" number="02" title="O produto veio com defeito">
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
      </LegalSection>

      <LegalSection
        id="como-iniciar"
        number="03"
        title="Como iniciar uma troca ou devolução"
      >
        <p>
          É só falar com a gente com o número do pedido em mãos
          {whatsapp || email ? ", por um destes canais:" : "."}
        </p>
        {whatsapp || email ? (
          <ul className="list-disc space-y-2 pl-5">
            {whatsapp ? (
              <li>
                <strong>WhatsApp:</strong> {whatsapp}
              </li>
            ) : null}
            {email ? (
              <li>
                <strong>E-mail:</strong> {email}
              </li>
            ) : null}
          </ul>
        ) : null}
        <p>
          Respondemos em até 2 dias úteis e conduzimos todo o processo com você,
          passo a passo. Nenhuma troca ou devolução é recusada dentro dos prazos
          e condições acima.
        </p>
      </LegalSection>

      <LegalSection id="dicas" number="04" title="Dicas para agilizar">
        <ul className="list-disc space-y-2 pl-5">
          <li>Guarde a embalagem até ter certeza de que vai ficar com o produto.</li>
          <li>
            Se possível, envie fotos do produto e do defeito na primeira
            mensagem — isso costuma resolver tudo mais rápido.
          </li>
          <li>Guarde o link de acompanhamento do seu pedido.</li>
        </ul>
      </LegalSection>
    </LegalArticle>
  );
}
