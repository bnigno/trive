// Diagnóstico da Lia — SÓ LEITURA. É o "antes e depois" de cada fase do plano
// "A Lia demora e parece por fora da loja": tempos dos turnos (fila, preparo,
// modelo, entrega, até o 1º balão — aceito pela Z-API e ENTREGUE no celular),
// origem de cada turno (inline / kick / cron), tokens e cache, ferramentas,
// falhas, transferências, cartões e o que o catálogo dá para a Lia dizer.
// Uso: npx tsx --env-file=.env.prod.local scripts/lia-diagnostico.ts [--dias 30]
import postgres from "postgres";

const dias = (() => {
  const index = process.argv.indexOf("--dias");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 30;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30;
})();

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const janela = sql`now() - make_interval(days => ${dias})`;

function secao(titulo: string): void {
  console.log(`\n=== ${titulo} ===`);
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? "sim" : "não";
  return String(value);
}

/** Tabela alinhada por colunas (sem paginador, sem dependência). */
function tabela(rows: readonly Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(nada)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((col) => Math.max(col.length, ...rows.map((row) => fmt(row[col]).length)));
  console.log(cols.map((col, i) => col.padEnd(widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(cols.map((col, i) => fmt(row[col]).padEnd(widths[i])).join("  "));
}

async function main(): Promise<void> {
  console.log(`Diagnóstico da Lia — últimos ${dias} dias — ${new Date().toISOString()}`);

  secao("CONFIGURAÇÕES DA LIA");
  tabela(
    await sql`
      select key, left(value::text, 400) as value
      from settings
      where key in ('bot_model','bot_seller_name','bot_extra_instructions','store_exchange_policy','store_name',
                    'bot_media_enabled','bot_cards_enabled','bot_audio_notes_enabled','bot_enabled','bot_mode',
                    'bot_photo_match_enabled')
      order by key`,
  );

  secao(`TURNOS DA LIA — tempos em segundos (mediana / p90)`);
  tabela(
    await sql`
      with t as (
        select
          (after->'timings'->>'queueWaitMs')::numeric/1000 as fila,
          (after->'timings'->>'prepMs')::numeric/1000 as preparo,
          (after->'timings'->>'modelMs')::numeric/1000 as modelo,
          (after->'timings'->>'toolsMs')::numeric/1000 as ferramentas,
          (after->'timings'->>'deliveryMs')::numeric/1000 as entrega,
          (after->'timings'->>'totalMs')::numeric/1000 as total,
          (after->'timings'->>'inboundToFirstBubbleMs')::numeric/1000 as ate_1o_balao
        from audit_log
        where action = 'wa.bot_turn' and created_at > ${janela}
      )
      select count(*) as turnos,
        round((percentile_cont(0.5) within group (order by fila))::numeric,1) as fila_p50, round((percentile_cont(0.9) within group (order by fila))::numeric,1) as fila_p90,
        round((percentile_cont(0.5) within group (order by preparo))::numeric,1) as prep_p50, round((percentile_cont(0.9) within group (order by preparo))::numeric,1) as prep_p90,
        round((percentile_cont(0.5) within group (order by modelo))::numeric,1) as modelo_p50, round((percentile_cont(0.9) within group (order by modelo))::numeric,1) as modelo_p90,
        round((percentile_cont(0.5) within group (order by ferramentas))::numeric,1) as tools_p50, round((percentile_cont(0.9) within group (order by ferramentas))::numeric,1) as tools_p90,
        round((percentile_cont(0.5) within group (order by entrega))::numeric,1) as entrega_p50, round((percentile_cont(0.9) within group (order by entrega))::numeric,1) as entrega_p90,
        round((percentile_cont(0.5) within group (order by ate_1o_balao))::numeric,1) as ate1balao_p50, round((percentile_cont(0.9) within group (order by ate_1o_balao))::numeric,1) as ate1balao_p90
      from t`,
  );

  secao("TURNOS POR ORIGEM (inline = na mesma chamada do webhook; kick = aviso ao Inngest; cron = varredura)");
  tabela(
    await sql`
      with t as (
        select coalesce(after->'timings'->>'source', 'sem origem') as origem,
          (after->'timings'->>'queueWaitMs')::numeric/1000 as fila,
          (after->'timings'->>'inboundToFirstBubbleMs')::numeric/1000 as ate_1o_balao
        from audit_log
        where action = 'wa.bot_turn' and created_at > ${janela} and after->>'mode' = 'autonomous'
      )
      select origem, count(*) as turnos,
        round((percentile_cont(0.5) within group (order by fila))::numeric,1) as fila_p50,
        round((percentile_cont(0.9) within group (order by fila))::numeric,1) as fila_p90,
        round((percentile_cont(0.5) within group (order by ate_1o_balao))::numeric,1) as ate1balao_p50,
        round((percentile_cont(0.9) within group (order by ate_1o_balao))::numeric,1) as ate1balao_p90
      from t group by origem order by turnos desc`,
  );

  secao("CLIENTE → 1º BALÃO: aceito pela Z-API (sent_at) e ENTREGUE no celular (segundos; junção pelo dedupe da resposta)");
  tabela(
    await sql`
      with r as (
        select extract(epoch from (coalesce(o.sent_at, o.created_at) - i.created_at)) as ate_aceito,
               extract(epoch from (o.delivered_at - i.created_at)) as ate_entregue
        from wa_messages o
        join wa_messages i on o.dedupe_key = 'wa.bot_reply:' || i.id::text
        where o.direction = 'outbound' and o.created_at > ${janela}
      )
      select count(*) as respostas, count(ate_entregue) as com_recibo,
        round((percentile_cont(0.5) within group (order by ate_aceito))::numeric,1) as aceito_p50,
        round((percentile_cont(0.9) within group (order by ate_aceito))::numeric,1) as aceito_p90,
        round((percentile_cont(0.5) within group (order by ate_entregue))::numeric,1) as entregue_p50,
        round((percentile_cont(0.9) within group (order by ate_entregue))::numeric,1) as entregue_p90
      from r`,
  );

  secao("CHAMADAS AO MODELO POR TURNO, TOKENS, CACHE");
  tabela(
    await sql`
      with t as (
        select jsonb_array_length(coalesce(after->'toolCalls','[]'::jsonb)) as n_tools,
          (after->'usage'->>'inputTokens')::numeric as in_tok,
          (after->'usage'->>'cacheReadTokens')::numeric as cache_tok,
          (after->'usage'->>'cacheWriteTokens')::numeric as cache_w,
          (after->'usage'->>'outputTokens')::numeric as out_tok,
          after->>'model' as model
        from audit_log where action = 'wa.bot_turn' and created_at > ${janela})
      select model, count(*) as turnos, round(avg(n_tools),2) as tools_media, round(avg(in_tok)) as in_tok_media,
        round(avg(cache_tok)) as cache_read_media, round(avg(cache_w)) as cache_write_media, round(avg(out_tok)) as out_tok_media,
        round(100.0*sum(case when cache_tok > 0 then 1 else 0 end)/count(*)) as pct_com_cache
      from t group by model order by turnos desc`,
  );

  secao("DISTRIBUIÇÃO DE FERRAMENTAS POR TURNO");
  tabela(
    await sql`
      select jsonb_array_length(coalesce(after->'toolCalls','[]'::jsonb)) as n_tools, count(*) as turnos
      from audit_log where action = 'wa.bot_turn' and created_at > ${janela}
      group by 1 order by 1`,
  );

  secao("FERRAMENTAS MAIS CHAMADAS");
  tabela(
    await sql`
      select tc->>'name' as tool, count(*) as vezes, sum(case when (tc->>'ok')::boolean then 0 else 1 end) as falhas
      from audit_log, jsonb_array_elements(coalesce(after->'toolCalls','[]'::jsonb)) tc
      where action = 'wa.bot_turn' and created_at > ${janela}
      group by 1 order by 2 desc limit 15`,
  );

  secao("FALHAS DO TURNO (wa.bot_turn_failed)");
  tabela(
    await sql`
      select after->>'reason' as motivo, after->>'code' as code, after->>'status' as status,
        count(*) as vezes, max((after->>'attempt')::int) as max_tentativa,
        to_char(max(created_at) at time zone 'America/Sao_Paulo','dd/mm hh24:mi') as ultima
      from audit_log
      where action = 'wa.bot_turn_failed' and created_at > ${janela}
      group by 1, 2, 3 order by vezes desc limit 10`,
  );

  secao("TRANSFERÊNCIAS PARA A EQUIPE (handedOff)");
  tabela(
    await sql`
      select (after->>'handedOff')::boolean as transferiu, count(*) as turnos from audit_log
      where action = 'wa.bot_turn' and created_at > ${janela} group by 1`,
  );

  secao("OS 10 TURNOS MAIS LENTOS (segundos)");
  tabela(
    await sql`
      select to_char(created_at at time zone 'America/Sao_Paulo','dd/mm hh24:mi') as quando,
        coalesce(after->'timings'->>'source','-') as origem,
        round((after->'timings'->>'queueWaitMs')::numeric/1000,1) as fila,
        round((after->'timings'->>'prepMs')::numeric/1000,1) as prep,
        round((after->'timings'->>'modelMs')::numeric/1000,1) as modelo,
        round((after->'timings'->>'toolsMs')::numeric/1000,1) as tools,
        round((after->'timings'->>'deliveryMs')::numeric/1000,1) as entrega,
        round((after->'timings'->>'inboundToFirstBubbleMs')::numeric/1000,1) as ate_1o_balao,
        (select string_agg(x->>'name', ',') from jsonb_array_elements(coalesce(after->'toolCalls','[]'::jsonb)) x) as tools_chamadas
      from audit_log where action = 'wa.bot_turn' and created_at > ${janela}
      order by (after->'timings'->>'inboundToFirstBubbleMs')::numeric desc nulls last limit 10`,
  );

  secao("CARTÕES RENDERIZADOS (ms)");
  tabela(
    await sql`
      select count(*) as cartoes, round((percentile_cont(0.5) within group (order by render_ms))::numeric) as p50,
        round((percentile_cont(0.9) within group (order by render_ms))::numeric) as p90, max(render_ms) as max
      from bot_cards where render_ms is not null and render_ms > 0`,
  );

  secao("CATÁLOGO: o que a Lia tem para falar das peças");
  tabela(
    await sql`
      select count(*) as pecas_ativas,
        sum(case when length(coalesce(description,'')) >= 80 then 1 else 0 end) as com_descricao,
        sum(case when coalesce(curator_note,'') <> '' then 1 else 0 end) as com_nota_curadora,
        sum(case when curator_audio_path is not null then 1 else 0 end) as com_audio_curadora,
        sum(case when coalesce(composition,'') <> '' then 1 else 0 end) as com_composicao,
        sum(case when coalesce(fit_notes,'') <> '' then 1 else 0 end) as com_como_veste,
        sum(case when coalesce(care_notes,'') <> '' then 1 else 0 end) as com_cuidados,
        sum(case when exists (select 1 from product_images pi where pi.product_id = p.id) then 1 else 0 end) as com_foto,
        sum(case when exists (select 1 from product_images pi where pi.product_id = p.id and coalesce(pi.alt_text,'') <> '') then 1 else 0 end) as com_alt_text
      from products p where deleted_at is null and status = 'active'`,
  );

  secao("STATUS DOS PRODUTOS");
  tabela(await sql`select status, count(*) as pecas from products where deleted_at is null group by 1 order by 1`);

  secao("CATEGORIAS");
  tabela(
    await sql`
      select c.name, count(p.id) as pecas from categories c
      left join products p on p.category_id = c.id and p.deleted_at is null and p.status = 'active'
      group by c.name order by 2 desc`,
  );

  secao("5 DESCRIÇÕES MAIS CURTAS (peças ativas)");
  tabela(
    await sql`
      select name, length(coalesce(description,'')) as tam_desc, left(coalesce(description,'(vazia)'), 90) as inicio
      from products where deleted_at is null and status = 'active' order by 2 asc, name limit 5`,
  );

  secao("MENSAGENS POR DIREÇÃO");
  tabela(await sql`select direction, count(*) as mensagens from wa_messages where created_at > ${janela} group by 1 order by 1`);
}

main()
  .catch((error) => {
    console.error("Diagnóstico falhou:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
