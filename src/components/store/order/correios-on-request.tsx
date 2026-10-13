"use client";
// Sem faixa de frete para o CEP: a entrega é pelos Correios e quem calcula o
// frete é a equipe (onde o motoboy chega, só ele aparece — regra em
// core/shipping). Se um motoboy cobre o CEP e só o peso da sacola ficou de
// fora, a entrega é por motoboy e a equipe confirma o valor — nada de
// Correios. O aviso manda a cliente para a Lia já com a sacola e o CEP na
// mensagem; sem WhatsApp configurado, só explica.
import { LiaLink } from "@/components/store/lia-link";
import { Notice } from "@/components/store/order/notice";

export function CorreiosOnRequestNotice({
  cepDigits,
  motoboyArea,
  motoboyCoversCep = false,
  sellerName,
  fallbackUrl,
  items,
  className,
}: {
  cepDigits: string;
  /** "Belém, Ananindeua e Castanhal" — vazio quando não há faixa de motoboy. */
  motoboyArea: string;
  /** Um motoboy cobre o CEP, mas nenhuma faixa aceita o peso desta sacola. */
  motoboyCoversCep?: boolean;
  sellerName: string;
  fallbackUrl: string | null;
  items: readonly { variantId: string; sku: string; quantity: number }[];
  className?: string;
}) {
  return (
    <Notice tone="gold" role="status" className={className}>
      <p>
        {motoboyCoversCep ? (
          <>
            Este CEP é atendido pelo nosso <strong>motoboy</strong>, mas o peso desta sacola está fora do que a entrega automática aceita: o frete é confirmado pela nossa equipe.
          </>
        ) : (
          <>
            {motoboyArea ? `Fora de ${motoboyArea}, a` : "A"} entrega para este CEP é pelos <strong>Correios</strong>, e o frete é calculado pela nossa equipe.
          </>
        )}
        {fallbackUrl ? ` Fale com a ${sellerName}: ela recebe a sua sacola e o CEP, e a gente te manda o valor.` : " Fale com a gente no WhatsApp e a gente te manda o valor."}
      </p>
      {fallbackUrl ? (
        <LiaLink source="cart" sellerName={sellerName} fallbackUrl={fallbackUrl} items={items} cep={cepDigits} className="mt-3 w-full sm:w-auto" />
      ) : null}
    </Notice>
  );
}
