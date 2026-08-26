import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { btnPrimary } from "@/components/store/styles";

export default function OrderNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-4 py-20 text-center">
      <Monogram size={56} className="opacity-40" />
      <h1 className="font-display text-title font-semibold text-ink-950">
        Pedido não encontrado
      </h1>
      <p className="max-w-md text-[15px] leading-7 text-ink-700">
        Não achamos nenhum pedido com este link. Confira se o endereço foi
        copiado por completo — ele costuma chegar por WhatsApp logo após a
        compra.
      </p>
      <Link href="/produtos" className={btnPrimary}>
        Ver produtos da loja
      </Link>
    </div>
  );
}
