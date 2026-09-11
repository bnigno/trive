// Cadastro da cliente na conversa: buscar_cadastro e a identidade usada no pedido.
import { and, desc, eq, isNull } from "drizzle-orm";
import { formatCep } from "@/core/bot/memory";
import {
  formatSavedAddressLines,
  pickSavedAddressForCep,
  summarizeRegistration,
  type SavedAddress,
  type SavedRegistration,
} from "@/core/bot/customer";
import { customerAddresses, customers } from "@/db/schema";
import type { DbOrTx } from "@/queue/enqueue";

import { loadBotState } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";

/**
 * Cadastro já salvo para este telefone: o cliente mais recente com o número,
 * mais TODOS os endereços dele (padrão primeiro, depois do mais recente) —
 * qual vale para a entrega é decidido pelo CEP cotado, nunca em silêncio.
 *
 * Cliente anonimizado por LGPD é IGNORADO de propósito — quem pediu para ser
 * esquecido não volta como sugestão de preenchimento.
 */
export async function loadSavedRegistration(
  db: DbOrTx,
  phoneE164: string,
): Promise<SavedRegistration | null> {
  const [customer] = await db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      documentNumber: customers.documentNumber,
    })
    .from(customers)
    .where(
      and(
        eq(customers.phoneE164, phoneE164),
        isNull(customers.deletedAt),
        isNull(customers.anonymizedAt),
      ),
    )
    .orderBy(desc(customers.updatedAt))
    .limit(1);
  if (!customer) return null;

  const addresses = await db
    .select({
      postalCode: customerAddresses.postalCode,
      street: customerAddresses.street,
      number: customerAddresses.number,
      complement: customerAddresses.complement,
      district: customerAddresses.district,
      city: customerAddresses.city,
      state: customerAddresses.state,
      isDefault: customerAddresses.isDefault,
    })
    .from(customerAddresses)
    .where(eq(customerAddresses.customerId, customer.id))
    .orderBy(desc(customerAddresses.isDefault), desc(customerAddresses.createdAt));

  return {
    fullName: customer.fullName,
    documentDigits: customer.documentNumber,
    addresses,
  };
}

export async function execBuscarCadastro(
  db: DbOrTx,
  ctx: BotExecutorContext,
): Promise<ToolResult> {
  const registration = await loadSavedRegistration(db, ctx.phoneE164);
  if (!registration) {
    return {
      ok: true,
      text: "Este telefone ainda não tem cadastro — é a primeira compra dele por aqui. Colete os dados normalmente, um por vez.\n\n[NUNCA diga ao cliente que a loja não guarda dados: guardamos, este número é que ainda não tem cadastro.]",
    };
  }
  const state = await loadBotState(db, ctx.conversationId);
  return {
    ok: true,
    text: summarizeRegistration(registration, { quotedCep: state.lastCep }),
  };
}

/** Dados pessoais do pedido, vindos do cadastro salvo OU do que o bot coletou. */
export type OrderIdentity = {
  fullName: string;
  documentDigits: string;
  postalCode: string;
  street: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  state: string;
};

export function identityFromSavedAddress(
  registration: SavedRegistration,
  address: SavedAddress,
): OrderIdentity {
  return {
    fullName: registration.fullName,
    documentDigits: (registration.documentDigits ?? "").replace(/\D/g, ""),
    postalCode: (address.postalCode ?? "").replace(/\D/g, ""),
    street: address.street ?? "",
    number: address.number ?? "",
    ...(address.complement ? { complement: address.complement } : {}),
    district: address.district ?? "",
    city: address.city ?? "",
    state: address.state ?? "",
  };
}

/**
 * Endereço do pedido no caminho do cadastro salvo: o salvo cujo CEP foi
 * cotado nesta conversa. Nunca o "padrão" em silêncio — foi assim que o
 * pedido #1012 saiu para a cidade errada.
 */
export function resolveSavedIdentity(
  registration: SavedRegistration,
  quotedCep: string | undefined,
): { ok: true; identity: OrderIdentity } | { ok: false; text: string } {
  const pick = pickSavedAddressForCep(registration.addresses, quotedCep);
  if (pick.kind === "one") {
    return { ok: true, identity: identityFromSavedAddress(registration, pick.address) };
  }
  const outro =
    "Se a entrega é em um endereço novo, colete-o e passe COMPLETO nos campos de criar_pedido junto com usar_cadastro_salvo true.";
  if (pick.kind === "ambiguous") {
    return {
      ok: false,
      text: [
        `Há ${pick.matches.length} endereços salvos com o CEP ${formatCep(quotedCep ?? "")}. Confirme com a cliente QUAL deles é o da entrega e passe esse endereço completo nos campos de criar_pedido junto com usar_cadastro_salvo true:`,
        ...formatSavedAddressLines(pick.matches),
      ].join("\n"),
    };
  }
  if (pick.usable.length === 0) {
    return {
      ok: false,
      text: `O cadastro deste telefone não tem endereço completo para entrega. Colete o endereço com a cliente, um dado por vez, e chame criar_pedido com o endereço COMPLETO nos campos junto com usar_cadastro_salvo true (nome e CPF continuam do cadastro).`,
    };
  }
  const lista = formatSavedAddressLines(pick.usable);
  if (!quotedCep) {
    return {
      ok: false,
      text: [
        "Ainda não há cotação de frete nesta conversa e a cliente tem mais de um endereço salvo. Confirme com ela QUAL é o da entrega, chame cotar_frete com o CEP desse endereço, apresente o resumo e, com o SIM, chame criar_pedido de novo:",
        ...lista,
        outro,
      ].join("\n"),
    };
  }
  return {
    ok: false,
    text: [
      `O frete foi cotado para o CEP ${formatCep(quotedCep)}, mas nenhum endereço salvo tem esse CEP. Confirme com a cliente onde é a entrega: se for em um dos salvos, chame cotar_frete com o CEP dele, apresente o novo resumo e, com o SIM, chame criar_pedido de novo:`,
      ...lista,
      outro,
    ].join("\n"),
  };
}
