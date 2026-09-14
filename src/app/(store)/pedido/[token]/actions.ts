"use server";

// Ação "Pagar agora" da página pública do pedido. Recebe SOMENTE o
// publicToken — o orderId é resolvido internamente pelo serviço e nunca chega
// ao cliente. Sucesso → redirect direto para o Checkout Pro (init_point).

import { redirect } from "next/navigation";
import { z } from "zod";

import { getPaymentGateway } from "@/adapters/mercadopago";
import { getDb } from "@/db/client";
import { confirmDeliveryByToken } from "@/services/delivery";
import {
  ensurePaymentPreferenceByToken,
  isMpEnabled,
} from "@/services/store-payments";

/**
 * "Chegou!": quem tem o link do pedido enviado confirma que recebeu — o
 * pedido vira entregue pela máquina de estados (sem foto). Efeito é só o
 * status; token inválido volta para a home.
 */
export async function confirmDeliveryAction(token: string): Promise<void> {
  const parsedToken = z.uuid().safeParse(token);
  if (!parsedToken.success) redirect("/");
  let outcome = "chegou";
  try {
    const result = await confirmDeliveryByToken(getDb(), { publicToken: parsedToken.data });
    if (!result.ok) outcome = "nao";
  } catch (error) {
    console.error("confirmDeliveryAction: não foi possível confirmar a entrega.", error);
    outcome = "nao";
  }
  redirect(`/pedido/${parsedToken.data}?chegou=${outcome === "chegou" ? "1" : "0"}`);
}

export async function payNowAction(token: string): Promise<void> {
  // Token inválido nunca vai parar em URL de redirect (nem no serviço).
  const parsedToken = z.uuid().safeParse(token);
  if (!parsedToken.success) redirect("/");

  const db = getDb();
  let initPointUrl: string | null = null;
  try {
    if (await isMpEnabled(db)) {
      const preference = await ensurePaymentPreferenceByToken(
        db,
        getPaymentGateway(),
        { publicToken: parsedToken.data },
      );
      initPointUrl = preference.initPointUrl;
    }
  } catch (error) {
    // Pedido expirado/pago/indisponível ou falha no MP: volta para a página
    // do pedido, que mostra o status real do banco + o caminho manual.
    console.error("payNowAction: não foi possível iniciar o pagamento.", error);
  }

  // redirect() lança NEXT_REDIRECT — precisa ficar FORA do try/catch acima.
  if (initPointUrl) redirect(initPointUrl);
  redirect(`/pedido/${parsedToken.data}?pagamento=indisponivel`);
}
