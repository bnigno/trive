# Incidente de segurança — banco acessível pela internet (22/09/2026)

Registro interno. Guarda o que aconteceu, como foi verificado e o que foi feito,
para o caso de a pergunta voltar — inclusive por parte de uma cliente ou da ANPD.

## Resumo

Entre a criação dos projetos Supabase e **22/09/2026 às 20h47 (Belém)**, qualquer
pessoa que soubesse o endereço do projeto conseguia **ler, alterar e apagar** todos
os dados da loja pela API REST do Supabase, usando a chave anônima — que não é
segredo: ela vai no navegador de qualquer visitante da página de login.

A causa: as 62 tabelas estavam sem *Row-Level Security* e os papéis públicos do
Supabase (`anon`, `authenticated`) tinham todos os privilégios, inclusive apagar e
esvaziar tabela. Não foi uma mudança recente — era assim desde o começo.

## Como chegou ao nosso conhecimento

O Supabase enviou um alerta automático (`rls_disabled_in_public`, severidade
CRITICAL) datado de **19/09/2026**, para os dois projetos. O dono encaminhou o
e-mail em 22/09 perguntando se era perigoso.

## O que foi confirmado (não é teoria)

Consulta à API pública de produção, com a chave anônima, em 22/09:

| Tabela | Resposta | Registros acessíveis |
| --- | --- | --- |
| `orders` | HTTP 206 | 5 pedidos |
| `customers` | HTTP 206 | 4 clientes |
| `users` | HTTP 206 | 3 usuários do painel |

Estado do banco no momento: 62 tabelas em `public`, **nenhuma** com RLS, **nenhuma**
política, e `anon`/`authenticated` com SELECT, INSERT, UPDATE, DELETE e TRUNCATE em
todas as 62. O mesmo valia para o projeto de desenvolvimento.

**Dados pessoais alcançáveis:** nome, CPF, telefone, endereço de entrega e histórico
de pedidos das clientes; e-mail e papel dos usuários do painel.

## O que a apuração mostrou

**Nenhum dado foi destruído.** As estatísticas do Postgres (`pg_stat_user_tables`,
acumuladas desde 24/07/2026) mostram exclusões que batem **exatamente** com a
limpeza pré-inauguração documentada de 18/09: audit_log 1035, outbox 870, inbound
360, pedidos 19, movimentos de estoque 51. Não há exclusão sem explicação.

**Sobre leitura, não há como afirmar pelo banco:** consultar não deixa rastro em
`pg_stat_user_tables`. A resposta está nos **logs de API do painel Supabase**
(Logs → API), que só o dono acessa. Como o aplicativo **não usa** essa API em
nenhum ponto, *qualquer* requisição a `/rest/v1/` nesses logs é de origem externa e
merece atenção. **Essa verificação está pendente.**

## O que foi feito

1. Backup manual de produção antes de qualquer alteração
   (`~/TRIVE-backups/trive-prod-2026-09-22-pre-rls.dump`, 1,1 MB, conferido) — o
   backup automático está quebrado desde 25/08 por falta do secret no GitHub.
2. Migração `drizzle/0058_rls_e_privilegios.sql`, em duas camadas:
   - RLS ligado nas 62 tabelas, sem nenhuma política (o padrão do Postgres é negar);
   - privilégios de `anon` e `authenticated` revogados, **e** os privilégios padrão
     alterados para que tabelas criadas no futuro não nasçam expostas.
3. Aplicada em produção e em desenvolvimento em 22/09/2026.
4. Teste `tests/db/rls.test.ts` que falha se qualquer tabela ficar sem RLS.

## Verificação depois da correção

| Checagem | Antes | Depois |
| --- | --- | --- |
| Ler `customers` pela API pública | HTTP 206, devolvia cliente | **HTTP 401**, "permission denied" |
| Apagar `customers` pela API pública | permitido | **HTTP 401**, "permission denied" |
| Tabelas sem RLS | 62 | **0** |
| Privilégios de anon/authenticated | 62 tabelas | **0** |

A loja e o painel continuaram funcionando (o aplicativo conecta como dono do banco,
que não é afetado por RLS): `/api/health` em `ok`, vitrine com as fotos, login de pé.

## O que ficou em aberto

- **Ler os logs de API do Supabase** nos dois projetos, para saber se alguém chegou a
  acessar. Só depois disso faz sentido decidir sobre avisar as 4 clientes.
- **Arquivos**: o bucket `product-images` é público e guarda comprovantes, fotos de
  entrega, fotos de clientes e o resumo diário com números de venda. Enquanto as
  tabelas eram legíveis, os caminhos desses arquivos também eram. Fechar o banco já
  esconde os caminhos; separar um bucket privado é o passo seguinte, planejado.
- **Backup automático**: continua quebrado. Enquanto não for religado, cada operação
  de risco depende de um dump manual.
