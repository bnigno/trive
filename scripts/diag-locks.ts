// Diagnóstico de locks: sessões ativas, transações abertas e bloqueios.
// Uso: npx tsx --env-file=<env> scripts/diag-locks.ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

async function main() {
  const activity = await sql`
    select pid, state, wait_event_type, wait_event,
           now() - xact_start as xact_age, now() - query_start as query_age,
           left(query, 120) as query
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and state is not null and state <> 'idle'
    order by xact_start nulls last`;
  console.log("=== sessões não-ociosas ===");
  for (const r of activity) {
    console.log(`pid=${r.pid} state=${r.state} wait=${r.wait_event_type ?? "-"}/${r.wait_event ?? "-"} xact=${r.xact_age ?? "-"} query=${r.query}`);
  }

  const idleTx = await sql`
    select pid, now() - xact_start as xact_age, left(query, 120) as last_query
    from pg_stat_activity
    where datname = current_database() and state = 'idle in transaction'
    order by xact_start`;
  console.log(`=== idle in transaction: ${idleTx.length} ===`);
  for (const r of idleTx) console.log(`pid=${r.pid} há ${r.xact_age} última=${r.last_query}`);

  const locks = await sql`
    select blocked.pid as blocked_pid, left(blocked.query,90) as blocked_query,
           blocking.pid as blocking_pid, blocking.state as blocking_state,
           now() - blocking.xact_start as blocking_xact_age, left(blocking.query,90) as blocking_query
    from pg_stat_activity blocked
    join lateral unnest(pg_blocking_pids(blocked.pid)) as b(bpid) on true
    join pg_stat_activity blocking on blocking.pid = b.bpid
    where blocked.datname = current_database()`;
  console.log(`=== bloqueios ativos: ${locks.length} ===`);
  for (const r of locks) {
    console.log(`bloqueado pid=${r.blocked_pid} (${r.blocked_query}) POR pid=${r.blocking_pid} state=${r.blocking_state} xact=${r.blocking_xact_age} (${r.blocking_query})`);
  }
  await sql.end();
  process.exit(0);
}

void main();
