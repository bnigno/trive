# TRIVÉ

Loja virtual própria + sistema de gestão (ERP) + automação de WhatsApp, feitos sob medida para a operação da TRIVÉ (~500 produtos, ~300 pedidos/mês).

Este README serve para duas pessoas: o **dono** (que opera a loja sem programar) e o **dev/IA** (que mantém o código). A parte técnica detalhada para agentes de IA está em [CLAUDE.md](./CLAUDE.md).

## O que é, em linguagem simples

- **Loja (site)**: onde o cliente compra. Pagamento via Mercado Pago (Fase 3).
- **Admin (ERP)**: onde o dono cadastra produtos, vê pedidos, estoque e a fila de eventos.
- **Fila**: tudo que fala com o mundo externo (e-mail, WhatsApp, Mercado Pago) passa por uma fila com registro no banco — se algo falhar, fica visível e dá para reprocessar com um botão.
- **WhatsApp (Z-API)**: mensagens automáticas de pedido/entrega (Fase 4).
- **Sem NF-e**: o checkout exige CPF e o sistema gera um CSV mensal para o contador.

## Stack (o que roda onde)

| Peça | O que faz | Onde |
| --- | --- | --- |
| Next.js + TypeScript | O site e o admin | Vercel |
| Postgres (Supabase) | O banco de dados — a fonte de verdade | Supabase (2 projetos: dev e prod) |
| Drizzle | Como o código conversa com o banco (com migrações versionadas) | no código |
| Inngest | Executor da fila de eventos | Inngest (nuvem) |
| Resend | E-mails transacionais | Resend |
| Z-API | WhatsApp | Z-API |
| GitHub Actions | CI (testes) + backup diário do banco | GitHub |

Custo projetado: ~R$210–260/mês no lançamento (detalhes em [docs/setup-externo.md](./docs/setup-externo.md)).

## Comandos básicos (dev)

```bash
pnpm install      # instala dependências
pnpm dev          # roda o site em http://localhost:3000
pnpm test         # roda os testes
pnpm typecheck    # confere os tipos
pnpm lint         # confere estilo e fronteiras de arquitetura
pnpm db:generate  # gera migração a partir do schema
pnpm db:migrate   # aplica migrações no banco
pnpm db:seed      # popula dados de desenvolvimento
```

## Estrutura de pastas

```text
src/
  core/       # regras de negócio puras (preço, status, estoque) — sem banco, sem internet
  services/   # casos de uso: "criar pedido", "confirmar pagamento" — 1 arquivo por ação
  adapters/   # conversa com serviços externos (Mercado Pago, Z-API, Resend), sempre com versão "fake" para testes
  db/         # schema do banco, conexão e migrações (Drizzle)
  queue/      # a fila: outbox no Postgres + funções Inngest
  app/        # as telas e rotas (Next.js) — só validam input e chamam services
tests/        # testes automatizados, por área
docs/         # documentação: setup externo, fases
scripts/      # verificações de CI (migrações destrutivas, segredos no client)
```

Regra de ouro da estrutura: as camadas só importam "para dentro" (app → services → core). O lint reclama se alguém furar a fila.

## Operação (para o dono)

O que olhar no dia a dia:

- **/admin/fila** (no próprio site): eventos da fila. Se algo aparecer como **morto** (dead), houve falha repetida — veja o erro e use o botão **Reprocessar**.
- **Painel da Vercel** (<https://vercel.com>): cada deploy aparece com status. Rollback é 1 clique (ver runbook abaixo).
- **Supabase Table Editor** (<https://supabase.com/dashboard>): para *ver* os dados. Não é para editar (ver runbook).

### Runbook (o que fazer quando...)

| Situação | O que fazer |
| --- | --- |
| Deploy quebrou o site | Na Vercel: projeto → Deployments → deployment anterior (verde) → menu **⋯** → **Promote to Production** (voltar à versão anterior). O site volta em ~1 min. |
| Evento morto na fila | Em /admin/fila, abra o evento, leia o erro, clique **Reprocessar**. Se morrer de novo, é bug: registre o erro e acione o dev/IA. |
| Precisa corrigir um dado no banco | **Nunca edite tabela direto em produção.** Peça uma correção via código/migração — assim fica registrado no audit log e não quebra as regras do sistema. |
| E-mail/WhatsApp não chegou | Confira /admin/fila primeiro: o evento saiu? Se está "done" no nosso lado, o problema é no provedor (Resend/Z-API). |

## Documentação

- [CLAUDE.md](./CLAUDE.md) — guia técnico para sessões de IA (arquitetura e regras).
- [docs/setup-externo.md](./docs/setup-externo.md) — checklist do que só o dono pode fazer (contas, chaves, custos).
- [docs/fase-0.md](./docs/fase-0.md) — o que a Fase 0 entrega e o critério de pronto.
