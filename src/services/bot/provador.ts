// A porta de entrada do Provador pela Lia: com a cartela preenchida e o sim
// dela, a cliente ganha cadastro (se não tinha), o opt-in de avisos no
// privado (auditado) e o cartão de boas-vindas com o link do grupo — que a
// LOJA manda pela fila, nunca o modelo. Ninguém é adicionado: ela entra
// tocando no convite; o sync da sala reconhece a entrada e a marca "pela Lia".
import { and, eq, isNull, sql } from "drizzle-orm";

import type { BotToolInputs } from "@/core/bot/tools";
import { renderWelcomeCard } from "@/core/groups/rituals";
import { auditLog, customers, waGroupMembers, waGroups } from "@/db/schema";
import { spDayKey } from "@/lib/sp-day";
import { type DbOrTx, enqueueOutboxEvent } from "@/queue/enqueue";
import { getSettingsMap } from "@/services/settings";
import { getStyleProfileByPhone } from "@/services/style-profiles";
import { loadGroupPolicy, PROVADOR_INVITE_ACTION } from "@/services/wa-groups";

import { DEFAULT_STORE_NAME, DRY_RUN_TEXT, readBotState, resolveConversationCustomerId } from "./shared";
import type { BotExecutorContext, ToolResult } from "./shared";


/** A sala em que uma cliente nova entra: a primeira ativa do tipo provador com link de convite. */
export async function pickProvadorRoom(db: DbOrTx): Promise<{ id: string; name: string; invitationLink: string } | null> {
  const [room] = await db
    .select({ id: waGroups.id, name: waGroups.name, invitationLink: waGroups.invitationLink })
    .from(waGroups)
    .where(and(eq(waGroups.isActive, true), eq(waGroups.kind, "provador"), sql`${waGroups.invitationLink} IS NOT NULL`))
    .orderBy(waGroups.createdAt)
    .limit(1);
  if (!room || !room.invitationLink) return null;
  return { id: room.id, name: room.name, invitationLink: room.invitationLink };
}

export async function execEntrarNoProvador(
  db: DbOrTx,
  ctx: BotExecutorContext,
  input: BotToolInputs["entrar_no_provador"],
): Promise<ToolResult> {
  if (ctx.dryRun) return { ok: true, text: DRY_RUN_TEXT };
  const now = ctx.now ?? new Date();
  const policy = await loadGroupPolicy(db);
  if (!policy.groupsEnabled) {
    return { ok: false, text: "O Provador está desligado no momento. Diga que o grupo abre em breve e que você avisa por aqui; não prometa data." };
  }
  const room = await pickProvadorRoom(db);
  if (!room) {
    return { ok: false, text: "A loja ainda não tem uma sala do Provador com link de convite. Diga que o grupo está sendo preparado e que você avisa por aqui." };
  }

  const profile = await getStyleProfileByPhone(db, ctx.phoneE164);
  const sizes = profile?.profile.sizes ?? {};
  if (!profile || !Object.values(sizes).some((size) => typeof size === "string" && size.trim() !== "")) {
    return {
      ok: false,
      text: "Ainda não sei o tamanho dela. Pergunte o tamanho (vestido, blusa ou calça) e uma cor que ela ama, grave com atualizar_cartela e chame entrar_no_provador de novo — é o que faz os avisos do Provador servirem.",
    };
  }

  // Cadastro: o existente ganha o opt-in; sem cadastro, nasce um mínimo com o nome dela.
  let customerId = await resolveConversationCustomerId(db, ctx);
  if (!customerId) {
    const state = await readBotState(db, ctx);
    const name = input.nome?.trim() || state.displayName?.trim() || "";
    if (name.length < 2) {
      return { ok: false, text: "Ela ainda não tem cadastro e eu não sei o nome dela. Pergunte o primeiro nome e chame de novo passando nome." };
    }
    const [created] = await db
      .insert(customers)
      .values({ fullName: name, phoneE164: ctx.phoneE164, marketingOptIn: true })
      .onConflictDoNothing()
      .returning({ id: customers.id });
    if (created) {
      customerId = created.id;
    } else {
      const [existing] = await db.select({ id: customers.id }).from(customers).where(and(eq(customers.phoneE164, ctx.phoneE164), isNull(customers.deletedAt))).limit(1);
      customerId = existing?.id ?? null;
    }
  }
  if (!customerId) return { ok: false, text: "Não consegui criar o cadastro dela agora. Avise a equipe com avisar_dono." };

  const [customer] = await db.select({ fullName: customers.fullName, marketingOptIn: customers.marketingOptIn }).from(customers).where(eq(customers.id, customerId)).limit(1);
  if (customer && !customer.marketingOptIn) {
    await db.update(customers).set({ marketingOptIn: true, updatedAt: sql`now()` }).where(eq(customers.id, customerId));
  }
  await db.insert(auditLog).values({
    actorType: "customer",
    actorId: customerId,
    action: "wa.opt_in",
    entityType: "customer",
    entityId: customerId,
    before: { marketingOptIn: customer?.marketingOptIn ?? false },
    after: { marketingOptIn: true },
    reason: "Pediu para entrar no Provador pela Lia",
  });

  const [member] = await db
    .select({ id: waGroupMembers.id })
    .from(waGroupMembers)
    .where(and(eq(waGroupMembers.groupId, room.id), eq(waGroupMembers.phoneE164, ctx.phoneE164), isNull(waGroupMembers.leftAt)))
    .limit(1);
  if (member) {
    return { ok: true, text: `Ela já está no ${room.name}. Diga isso em 1 frase e siga a conversa (os avisos no privado já estão ligados).` };
  }

  const settings = await getSettingsMap(db, ["store_name", "bot_seller_name"]);
  const storeName = typeof settings["store_name"] === "string" && settings["store_name"].trim() ? settings["store_name"] : DEFAULT_STORE_NAME;
  const sellerName = typeof settings["bot_seller_name"] === "string" && settings["bot_seller_name"].trim() ? settings["bot_seller_name"] : "Lia";
  const firstName = (customer?.fullName ?? "").trim().split(/\s+/)[0] || null;
  const card = renderWelcomeCard({
    storeName,
    sellerName,
    firstName,
    windowStartHour: policy.cadence.window.startHour,
    windowEndHour: policy.cadence.window.endHour,
    postsPerWeek: policy.cadence.postsPerWeek,
  });
  const dedupeKey = `${PROVADOR_INVITE_ACTION}:${ctx.phoneE164}:${spDayKey(now)}`;
  // Resposta a um pedido dela: não exige opt-in (que acabou de nascer) e sai pela fila como tudo.
  await enqueueOutboxEvent(
    db,
    {
      eventType: "wa.send",
      dedupeKey,
      aggregateType: "wa_conversation",
      aggregateId: ctx.conversationId,
      payload: { templateKey: null, phoneE164: ctx.phoneE164, customerId, body: `${card}\n\nSeu convite: ${room.invitationLink}`, dedupeKey },
    },
    { kick: false },
  );
  await db.insert(auditLog).values({
    actorType: "customer",
    actorId: customerId,
    action: PROVADOR_INVITE_ACTION,
    entityType: "wa_group",
    entityId: room.id,
    after: { phoneE164: ctx.phoneE164, customerId, groupId: room.id },
  });
  return {
    ok: true,
    text: `[A loja enviou à cliente o cartão de boas-vindas do ${room.name} com o link do grupo — ela entra tocando nele.] Diga em 1 frase que o convite chegou logo abaixo e o que ela vai encontrar lá (terça as chegadas, quinta a enquete, sábado quem vestiu); não repita o link nem as regras, e não diga que ela "já está" no grupo.`,
  };
}
