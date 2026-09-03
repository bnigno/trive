# TRIVÉ — guia para sessões de IA

## Visão (3 linhas)

E-commerce próprio brasileiro + ERP interno + automação de WhatsApp (Z-API) para uma operação pequena (~500 produtos, ~300 pedidos/mês).
Mantido por um não-programador com auxílio de IA: código simples, explícito e testado vale mais do que código esperto.
Stack: Next.js (App Router) + TypeScript estrito + Drizzle/Postgres (Supabase) + Inngest, deploy na Vercel.

## Arquitetura em camadas (regra de importação com lint de fronteiras)

```text
core/ → services/ → adapters/ → db/ → queue/ → app/
```

- `src/core/` — regras de negócio puras, ZERO I/O. Só importa `core/` e `lib/`. Nada de fetch, banco, env, Date.now espalhado.
- `src/services/` — casos de uso; orquestra core + db + outbox dentro de transação.
- `src/adapters/` — todo vendor externo atrás de interface própria: `index.ts` (interface) + `client.ts` (real) + `fake.ts` (dev/teste). Seleção via `ADAPTER_MODE`.
- `src/db/` — Drizzle: schema, client (`getDb()` lazy singleton), migrações.
- `src/queue/` — outbox no Postgres é a fonte de verdade; Inngest é só o executor.
- `src/app/` — controllers burros: valida input com Zod, chama 1 service, renderiza. Sem regra de negócio.

O lint de fronteiras (eslint-plugin-boundaries) bloqueia importações na direção errada. Não contorne com `eslint-disable`.

## As 12 regras de ouro

1. Todo vendor externo tem adapter com interface própria + `fake.ts`. Nunca importe SDK de vendor fora de `adapters/`.
2. Dinheiro é SEMPRE inteiro em centavos (sufixo `_cents`/`Cents`). Nunca float, nunca `number` com decimais.
3. Transição de status (pedido, pagamento, evento) só passa pela máquina de estados em `core/`. Nunca faça `UPDATE status` direto.
4. Estoque é ledger append-only: saldo é derivado das movimentações; nunca sobrescreva quantidade.
5. Efeito externo (e-mail, WhatsApp, MP) só via fila: grave em `outbox_events` NA MESMA transação da mudança de estado.
6. Handler de fila é idempotente; o árbitro de duplicata é um UNIQUE no banco (`dedupe_key`, `(source, external_event_id)`), não memória.
7. Zod em toda fronteira: input de server action, route handler e payload de webhook/fila. Parse, não cast.
8. 1 caso de uso = 1 service com nome de verbo. Controller não combina services.
9. UI não busca dados nem contém regra: página chama service (RSC) ou action; componente só apresenta.
10. Uma única política de retry/backoff, em `core/queue/retry-policy.ts`. Nenhum retry ad hoc.
11. Mudança em `core/` exige teste novo/atualizado no mesmo PR.
12. Migração destrutiva (DROP/DELETE/coluna removida) exige o marcador `-- destructive: approved` no arquivo SQL; o CI bloqueia sem ele.

## Comandos

```text
pnpm dev          # servidor local
pnpm test         # vitest (tests/<área>/)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint (inclui fronteiras)
pnpm db:generate  # gera migração a partir do schema
pnpm db:migrate   # aplica migrações
pnpm db:seed      # dados de desenvolvimento
```

## Convenções

- Código, identificadores e tabelas em inglês, `snake_case` no banco; texto de UI em português do Brasil.
- Timestamps: `timestamptz` UTC no banco; formate em `America/Sao_Paulo` só na borda de exibição.
- Import alias `@/*` → `src/*`. Testes em `tests/<área>/`.
- Comentário só quando o código não consegue expressar a restrição.
- API de lib em dúvida? Inspecione `node_modules/<pacote>` em vez de chutar.
