// Termos de uso e condições de compra — página institucional com ISR.
// Identificação da loja conforme o Decreto 7.962/2013 (Lei do E-commerce).
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { getSettingsMap } from "@/services/settings";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Termos de uso",
  description:
    "Condições de compra da loja: identificação, como o pedido funciona, preços, entrega e responsabilidades.",
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
  const storeName = settingText(s, "store_name");
  const cnpj = settingText(s, "store_cnpj");
  const address = settingText(s, "store_address");
  const email = settingText(s, "store_email");
  const whatsapp = settingText(s, "store_whatsapp");

  return (
    <article className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
      <h1 className="font-display text-title font-semibold tracking-tight text-ink-950">
        Termos de uso
      </h1>
      <p className="mt-4 font-display text-xl leading-relaxed text-ink-700 italic">
        Estas são as condições de compra da {storeName}, escritas para serem
        entendidas — não para confundir. Ao fazer um pedido, você concorda com o
        que está descrito aqui.
      </p>

      <Section title="Quem somos">
        <p>
          Esta loja é operada por <strong>{storeName}</strong>, CNPJ{" "}
          <strong>{cnpj}</strong>, com endereço em <strong>{address}</strong> —
          informações publicadas em cumprimento ao Decreto 7.962/2013, que
          regula o comércio eletrônico no Brasil.
        </p>
        <p>
          Fale com a gente pelo WhatsApp ({whatsapp}) ou pelo e-mail ({email}).
        </p>
      </Section>

      <Section title="Como a compra funciona">
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
      </Section>

      <Section title="Preços e disponibilidade">
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
      </Section>

      <Section title="Entrega">
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
      </Section>

      <Section title="Trocas, devoluções e arrependimento">
        <p>
          Você tem 7 dias corridos após o recebimento para desistir da compra
          (art. 49 do CDC), além das garantias legais contra defeitos. Os
          detalhes e o passo a passo estão na nossa página de{" "}
          <a
            href="/trocas-e-devolucoes"
            className="font-medium text-gold-800 underline underline-offset-4"
          >
            trocas e devoluções
          </a>
          .
        </p>
      </Section>

      <Section title="Responsabilidades">
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
      </Section>

      <Section title="Dúvidas">
        <p>
          Qualquer dúvida sobre estes termos, é só chamar no WhatsApp (
          {whatsapp}) ou escrever para {email}. Estes termos podem ser
          atualizados de tempos em tempos; a versão publicada nesta página é
          sempre a que vale.
        </p>
      </Section>
    </article>
  );
}
