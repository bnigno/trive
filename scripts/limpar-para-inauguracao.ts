// Limpeza pré-inauguração (decisão da dona, 2026-09-18): apaga de produção
// TODAS as conversas do WhatsApp, TODOS os clientes e TODOS os pedidos de
// teste (com entregas, reservas, fotos e comprovantes), recalcula o estoque
// só a partir de compras/ajustes, arquiva as peças de teste, apaga a faixa
// de frete de teste e reinicia a numeração no #1001. A regra mora em
// core/maintenance/launch-reset.ts; a transação em services/launch-reset.ts.
// Simulação por padrão; grava só com --apply --confirmo=LIMPAR-PRODUCAO.
// Antes de gravar, exporta em JSON as linhas que vão sumir (rede de
// arrependimento); depois do commit apaga os arquivos do bucket.
// Uso:
//   npx tsx --env-file=.env.prod.local scripts/limpar-para-inauguracao.ts
//   npx tsx --env-file=.env.prod.local scripts/limpar-para-inauguracao.ts --apply --confirmo=LIMPAR-PRODUCAO [--sem-storage] [--exportar=DIR]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

import { getAdapterMode } from "@/adapters/adapter-mode";
import { getFileStorage } from "@/adapters/storage";
import { LAUNCH_RESET_CONFIRMATION, STORAGE_WIPE_PREFIXES, WIPE_STEPS, describeDatabaseTarget, isWipeStoragePath } from "@/core/maintenance/launch-reset";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { applyLaunchReset, assertQueueIdle, planLaunchReset, type LaunchResetPlan, type LaunchResetReport } from "@/services/launch-reset";

const STORE_TZ = "America/Sao_Paulo";
const BUCKET = "product-images";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
const when = (date: Date | null) => (date ? new Intl.DateTimeFormat("pt-BR", { timeZone: STORE_TZ, dateStyle: "short", timeStyle: "short" }).format(date) : "—");
const rowsOf = <T,>(res: unknown): T[] => (Array.isArray(res) ? (res as T[]) : ((res as { rows?: T[] }).rows ?? []));

function printPlan(plan: LaunchResetPlan): void {
  const c = plan.counts;
  console.log("\n== Conversas do WhatsApp ==");
  console.log(`${c.wa_conversations} conversa(s), ${c.wa_messages} mensagem(ns), ${c.wa_followups} retorno(s), ${c.wa_suggestions} sugestão(ões), ${c.atelier_intakes} captura(s) do ateliê.`);
  for (const conv of plan.conversations) console.log(`  • ${conv.name ?? "(sem nome)"} ${conv.phone} — ${conv.status}, última recebida ${when(conv.lastInboundAt)}`);
  console.log("\n== Clientes ==");
  console.log(`${c.customers} cliente(s), ${c.customer_addresses} endereço(s), ${c.customer_profiles} cartela(s), ${c.customer_looks} foto(s) "quem já vestiu", ${c.stock_holds} reserva(s), ${c.stock_alerts} avisa-me, ${c.drop_invites} convite(s) VIP, ${c.drop_waitlist} lista(s) de espera, ${c.site_carts} sacola(s) do site.`);
  for (const cust of plan.customers) console.log(`  • ${cust.name} ${cust.phone ?? "(sem telefone)"}${cust.marketingOptIn ? " — aceitou novidades" : ""} — cadastro ${when(cust.createdAt)}`);
  console.log("\n== Pedidos e entregas ==");
  console.log(`${c.orders} pedido(s) (último #${plan.orderNumbers.maxOrderNumber ?? "—"}), ${c.order_items} item(ns), ${c.order_status_history} mudança(s) de status, ${c.financial_entries} lançamento(s) financeiro(s) de pedido, ${c.delivery_feedback} "chegou bem?", ${c.delivery_runs} saída(s) de motoboy com ${c.delivery_stops} parada(s) e ${c.delivery_positions} posição(ões).`);
  console.log(`Depois da limpeza o próximo pedido é o #${plan.orderNumbers.nextAfterReset}.`);
  console.log("\n== Estoque ==");
  console.log(`${c.stock_movements} movimento(s) de venda/reserva de teste saem do livro. Saldos que mudam (em mãos/reservado, antes → depois):`);
  if (plan.stock.levels.length === 0) console.log("  (nenhum)");
  for (const l of plan.stock.levels) console.log(`  • ${l.sku} (${l.productName}): ${l.before.onHand}/${l.before.reserved} → ${l.after.onHand}/${l.after.reserved}`);
  if (plan.stock.manualMovements.length > 0) {
    console.log("Ajustes e perdas lançados à mão (ficam — confira se algum foi para 'consertar' uma baixa de teste):");
    for (const m of plan.stock.manualMovements) console.log(`  • ${when(m.createdAt)} ${m.sku} ${m.type} ${m.quantityDelta > 0 ? "+" : ""}${m.quantityDelta}${m.note ? ` — ${m.note}` : ""}`);
  }
  if (plan.stock.invalid.length > 0) {
    console.log("AVISO: o --apply vai RECUSAR — o recálculo deixaria saldo inválido (reservado ≠ 0 ou em mãos < 0). Corrija no histórico antes:");
    for (const v of plan.stock.invalid) console.log(`  • ${v.sku}: em mãos ${v.onHand}, reservado ${v.reserved}`);
  }
  if (plan.stock.preDivergences.length > 0) {
    console.log("AVISO: o saldo já não batia com o histórico ANTES da limpeza; ela deixa o saldo igual ao histórico:");
    for (const d of plan.stock.preDivergences) console.log(`  • ${d.sku}: saldo ${d.level.onHand}/${d.level.reserved}, histórico ${d.ledger.onHand}/${d.ledger.reserved}`);
  }
  console.log("\n== Fila, eventos e auditoria ==");
  console.log(`Fila: ${plan.outbox.toDelete} de ${plan.outbox.total} evento(s) saem (${plan.outbox.toKeep} ficam)${plan.outbox.processing > 0 ? ` — ${plan.outbox.processing} EM PROCESSAMENTO AGORA` : ""}.`);
  console.log(`Recebidos: ${plan.inbound.zapiToDelete} da Z-API saem (${plan.inbound.zapiToKeep} das últimas 24 h ficam); Mercado Pago (${plan.inbound.mercadopago}) e e-mail (${plan.inbound.email}) ficam.`);
  console.log(`Auditoria: ${plan.audit.toDelete} linha(s) sobre gente saem, ${plan.audit.toKeep} ficam.`);
  console.log("\n== Faxina extra ==");
  console.log(plan.coupons.length > 0 ? `Cupons com uso zerado: ${plan.coupons.map((cp) => `${cp.code} (${cp.usedCount})`).join(", ")}.` : "Cupons: nenhum uso para zerar.");
  console.log(plan.products.length > 0 ? "Peças de teste a ARQUIVAR:" : "Peças de teste: nenhuma.");
  for (const p of plan.products) console.log(`  • ${p.name} (${p.status}; SKU ${p.skus.join(", ") || "—"})${p.linkedTo.length ? ` — ainda ligada a ${p.linkedTo.join(", ")}` : ""}`);
  console.log(plan.shippingRates.length > 0 ? "Faixas de frete de teste a APAGAR:" : "Faixas de frete de teste: nenhuma.");
  for (const r of plan.shippingRates) console.log(`  • ${r.name} (${brl(r.priceCents)}, ${r.isActive ? "ativa" : "inativa"})`);
  if (plan.supplierEntries.length > 0) {
    console.log("Compras/contas a pagar de fornecedor (FICAM — confira se alguma é de teste e apague no painel):");
    for (const e of plan.supplierEntries) console.log(`  • ${when(e.createdAt)} ${e.description} ${brl(e.amountCents)} (${e.status})`);
  }
  for (const d of plan.scheduledDropsWithInvites) console.log(`AVISO: o lançamento "${d.name}" (${when(d.publishAt)}) tinha ${d.invites} convite(s) VIP — sem clientes, a fase VIP não manda para ninguém.`);
  console.log("\n== Arquivos no bucket ==");
  console.log(`${plan.storagePaths.length} arquivo(s) referenciado(s) (comprovantes, embalagens, entregas, bilhetes, cartões da edição, fotos de look, cartões do ateliê); órfãos nos prefixos ${STORAGE_WIPE_PREFIXES.join(" ")} também saem.`);
}

async function exportRows(db: ReturnType<typeof getDb>, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const partial: Partial<Record<(typeof WIPE_STEPS)[number], string>> = {
    inbound_events: `WHERE source = 'zapi'`,
    stock_movements: `WHERE reference_type IN ('order', 'hold')`,
    financial_entries: `WHERE order_id IS NOT NULL`,
  };
  // Também o que é atualizado/apagado fora da lista: faixas, peças, cupons e saldos de antes.
  const extra = ["shipping_rates", "products", "product_variants", "coupons", "stock_levels"];
  for (const table of [...WIPE_STEPS, ...extra]) {
    const rows = rowsOf<Record<string, unknown>>(await db.execute(sql.raw(`SELECT * FROM "${table}" ${partial[table as (typeof WIPE_STEPS)[number]] ?? ""}`)));
    writeFileSync(join(dir, `${table}.json`), JSON.stringify(rows, null, 1));
  }
  console.log(`Linhas exportadas em ${dir} (uma cópia do que vai sumir; apague quando não precisar mais).`);
}

async function listBucketPaths(db: ReturnType<typeof getDb>, prefixes: readonly string[]): Promise<string[] | null> {
  try {
    const pattern = `^(${prefixes.map((p) => p.replace(/\/$/, "")).join("|")})/`;
    const rows = rowsOf<{ name: string }>(await db.execute(sql`SELECT name FROM storage.objects WHERE bucket_id = ${BUCKET} AND name ~ ${pattern}`));
    return rows.map((r) => r.name);
  } catch (error) {
    console.warn(`(não consegui listar o bucket pelo banco: ${error instanceof Error ? error.message : error})`);
    return null;
  }
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const skipStorage = process.argv.includes("--sem-storage");
  const target = describeDatabaseTarget(process.env.DATABASE_URL ?? "");
  console.log(`Banco: ${target.host} / ${target.database}${apply ? "" : " (simulação — nada será gravado)"}`);

  const db = getDb();
  const [owner] = await db.select({ id: users.id, name: users.fullName }).from(users).where(eq(users.role, "owner")).limit(1);
  if (!owner) {
    console.error("Nenhum usuário owner para assinar a auditoria. Nada foi feito.");
    return 2;
  }

  const plan = await planLaunchReset(db);
  printPlan(plan);

  if (!apply) {
    console.log(`\nSimulação — nada foi gravado. Para aplicar: --apply --confirmo=${LAUNCH_RESET_CONFIRMATION}`);
    return 0;
  }
  if (arg("confirmo") !== LAUNCH_RESET_CONFIRMATION) {
    console.error(`\nConfirmação não confere (esperado --confirmo=${LAUNCH_RESET_CONFIRMATION}). Nada foi feito.`);
    return 2;
  }
  if (!skipStorage && getAdapterMode() !== "real") {
    console.error("\nADAPTER_MODE não é 'real': os arquivos do bucket não seriam apagados. Use --sem-storage para limpar só o banco. Nada foi feito.");
    return 2;
  }
  try {
    await assertQueueIdle(db);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : error} Nada foi feito.`);
    return 2;
  }

  // O storage real precisa das variáveis do Supabase: falhar AQUI, não depois do commit.
  const storage = skipStorage ? null : getFileStorage();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await exportRows(db, arg("exportar") ?? join(tmpdir(), `trive-limpeza-${stamp}`));

  const before = skipStorage ? null : await listBucketPaths(db, ["products", "cards"]);
  const report = await applyWithRetry(db, owner.id);
  printReport(report, owner.name ?? owner.id);

  if (!storage) {
    console.log("\nArquivos do bucket não tocados (--sem-storage). Caminhos referenciados:");
    for (const path of report.plan.storagePaths) console.log(`  ${path}`);
    return 0;
  }

  // Daqui em diante o banco JÁ ESTÁ LIMPO: qualquer erro é "faltou arquivo", nunca "nada foi gravado".
  try {
    return await purgeBucket(db, storage, report, before);
  } catch (error) {
    console.error(`\nBanco limpo (auditoria #${report.auditLogId}), mas a limpeza do bucket falhou: ${describeError(error)}`);
    console.error("Apague à mão no Supabase Storage (bucket product-images):");
    for (const path of report.plan.storagePaths) console.error(`  ${path}`);
    return 3;
  }
}

function printReport(report: LaunchResetReport, ownerName: string): void {
  console.log(`\nGravado (auditoria #${report.auditLogId}, ${ownerName}).`);
  for (const [table, n] of Object.entries(report.deleted)) if (n > 0) console.log(`  apagado ${table}: ${n}`);
  console.log(
    `  saldos recalculados: ${report.levelsWritten}; cupons zerados: ${report.couponsReset}; peças arquivadas: ${report.productsArchived.join(", ") || "nenhuma"} (${report.variantsDeactivated} variante(s) desativada(s)); faixas apagadas: ${report.ratesDeleted.join(", ") || "nenhuma"}; vigia silenciado para ${report.watchdogSilenced} endereço(s); ${report.revalidateEvents === null ? "revalidação da vitrine NÃO enfileirada (a ISR resolve em 5 min)" : `${report.revalidateEvents} pedido(s) de revalidação da vitrine`}.`,
  );
  console.log(`  próximo pedido: #${report.plan.orderNumbers.nextAfterReset}.`);
}

/** O drizzle embrulha o erro do Postgres: a mensagem de verdade ("deadlock detected", "permission denied") fica na causa. */
function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string" && message && !parts.includes(message)) parts.push(message.split("\n")[0]);
  }
  return parts.join(" ← ") || String(error);
}

function pgErrorCode(error: unknown): string | null {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** Deadlock (40P01) ou trava ocupada (55P03) = alguém estava no meio de uma escrita; uma nova tentativa depois de 15 s costuma bastar. */
async function applyWithRetry(db: ReturnType<typeof getDb>, userId: string): Promise<LaunchResetReport> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await applyLaunchReset(db, { userId });
    } catch (error) {
      // O drizzle embrulha o erro do Postgres (DrizzleQueryError.cause); o código SQLSTATE está na causa.
      const code = pgErrorCode(error);
      if (attempt < 3 && (code === "40P01" || code === "55P03")) {
        console.warn(`Banco ocupado (${code === "40P01" ? "deadlock" : "trava ocupada"}: ${describeError(error)}); nada foi gravado. Nova tentativa em 15 s (${attempt}/2)…`);
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        continue;
      }
      throw error;
    }
  }
}

async function purgeBucket(db: ReturnType<typeof getDb>, storage: ReturnType<typeof getFileStorage>, report: LaunchResetReport, before: string[] | null): Promise<number> {
  const orphans = await listBucketPaths(db, STORAGE_WIPE_PREFIXES);
  // Listagem que falha OU volta vazia com fotos de produto existentes: não dá para prometer os órfãos.
  const sweepOk = orphans !== null && before !== null && before.length > 0;
  if (!sweepOk) console.warn("(a varredura de órfãos no bucket não foi possível — só os arquivos referenciados serão apagados)");
  const paths = [...new Set([...report.plan.storagePaths, ...(orphans ?? [])])].filter(isWipeStoragePath).sort();
  const failed: string[] = [];
  for (const path of paths) {
    try {
      await storage.remove(path);
    } catch (error) {
      failed.push(path);
      console.warn(`  não apagou ${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\nBucket: ${paths.length - failed.length} arquivo(s) apagado(s)${failed.length ? `, ${failed.length} falhou(aram)` : ""}.`);
  const after = sweepOk ? await listBucketPaths(db, ["products", "cards"]) : null;
  if (before && after && before.length !== after.length) {
    console.error(`ATENÇÃO: fotos de produto/cartões mudaram de ${before.length} para ${after.length} — confira o bucket.`);
  }
  if (failed.length > 0) {
    console.error("Apague à mão no Supabase Storage (bucket product-images):");
    for (const path of failed) console.error(`  ${path}`);
  } else if (!sweepOk) {
    console.error(`Os arquivos referenciados foram apagados; só a varredura de órfãos não foi possível — confira no Supabase Storage os prefixos ${STORAGE_WIPE_PREFIXES.join(" ")}.`);
  }
  return failed.length > 0 || !sweepOk ? 3 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // Só chega aqui antes do commit (a transação desfaz tudo) — depois dele os erros viram código 3 acima.
    console.error(describeError(error));
    console.error("Nada foi gravado.");
    process.exit(1);
  });
