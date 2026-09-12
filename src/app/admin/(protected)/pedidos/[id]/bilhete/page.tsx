// Bilhete do presente para imprimir (15 × 10 cm): a mesma imagem que a
// cliente viu no WhatsApp. Sem imagem (render falhou), o texto sai em HTML
// com a tipografia do painel — melhor um bilhete simples do que nenhum.
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { giftSignature } from "@/core/gifts/text";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { giftNoteUrl } from "@/services/gifts";
import { getOrderDetail } from "@/services/orders";

import { PrintButton } from "@/components/admin/print-button";

export const dynamic = "force-dynamic";

export default async function GiftNotePrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const order = await getOrderDetail(getDb(), id);
  if (!order || !order.isGift) notFound();

  const imageUrl = order.giftNotePath
    ? giftNoteUrl(getFileStorage(), order.giftNotePath, order.updatedAt)
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      {/* Na impressão só o bilhete aparece: a casca do painel some. */}
      <style>{`@media print { body * { visibility: hidden !important; } .gift-print, .gift-print * { visibility: visible !important; } .gift-print { position: absolute; left: 0; top: 0; margin: 0; } @page { margin: 1cm; } }`}</style>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link
            href={`/admin/pedidos/${order.id}`}
            className="text-sm text-indigo-600 hover:underline dark:text-indigo-400"
          >
            ← Pedido #{order.orderNumber}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
            Bilhete do presente
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Imprima em papel de gramatura alta e corte em 15 × 10 cm. Vai dentro do pacote,
            sem preço.
          </p>
        </div>
        <PrintButton label="Imprimir bilhete" />
      </div>

      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`Bilhete para ${order.giftRecipientName ?? ""}`}
          className="gift-print mx-auto block border border-zinc-200 bg-white print:border-0"
          style={{ width: "15cm", height: "10cm" }}
        />
      ) : (
        <div
          className="gift-print mx-auto flex flex-col items-center justify-center gap-4 border border-zinc-300 bg-white p-8 text-center text-zinc-900"
          style={{ width: "15cm", height: "10cm" }}
        >
          <p className="text-xs tracking-[0.3em] text-amber-800">
            PARA {(order.giftRecipientName ?? "").toUpperCase()}
          </p>
          <p className="whitespace-pre-line font-serif text-lg italic">
            {order.giftMessage ?? "Um presente escolhido com carinho."}
          </p>
          <p className="font-serif text-base">{giftSignature(order.customer?.fullName ?? "")}</p>
        </div>
      )}
    </div>
  );
}
