# Runbook TRIVË — o que fazer quando algo der errado

Versão resumida para leitura fora do admin. A versão completa, em linguagem
leiga e com links clicáveis, está no painel: **/admin/ajuda**.

## O site caiu ou está estranho

1. Health check: <https://trive-lime.vercel.app/api/health> — se responder
   `ok`, site e banco estão de pé.
2. Problema geral da Vercel? <https://status.vercel.com>.
3. Quebrou após uma atualização? Vercel → projeto → **Deployments** → versão
   anterior → **Promote to Production**. Volta em ~1 minuto e não apaga dados
   (o banco é separado do site).

## Mensagem ou e-mail não chegou

Mensagens e e-mails passam por uma fila com **retry automático** (tentativas
repetidas com espera crescente) — atraso de minutos é normal. Se não chegar:
**/admin/fila** → **Reprocessar** os itens em falha definitiva e ler o motivo
mostrado no item.

## WhatsApp desconectou

**/admin/whatsapp** → escanear o QR code (WhatsApp → Aparelhos conectados).
Nada se perde: as mensagens ficam guardadas na fila e saem ao reconectar.
Depois, reprocessar pendências em **/admin/fila**.

## Preço não atualiza na loja

1. Pode estar aguardando aprovação: **/admin/precos/pendencias**.
2. A vitrine tem cache de **5 minutos** — preço recém-aprovado pode demorar
   esse tempo para aparecer.

Aprovação em lote: em **/admin/precos/pendencias**, as propostas de um mesmo
recálculo aparecem agrupadas; use **Aprovar lote** / **Rejeitar lote** (com
motivo).

## Estoque não bate

O **histórico de movimentações é a verdade**. Consultar o histórico do
produto em **/admin/estoque**, contar fisicamente e, se a diferença for real,
fazer **ajuste com motivo** (nunca "consertar" com venda/entrada falsa).

## Backup e restauração

- Backup diário automático: workflow **Backup** em
  <https://github.com/bnigno/trive/actions> (03:00 UTC), artifact
  `trive-backup` retido por 30 dias.
- Depende do secret **DATABASE_URL** do repositório (Settings → Secrets and
  variables → Actions). Se a senha do banco mudar, atualizar o secret.
- Restauração: `scripts/restore-backup.ts` (ver abaixo). O script trava se o
  destino parecer produção e exige digitar `RESTAURAR PRODUCAO`.

### Teste de restauração trimestral

Backup que nunca foi restaurado não é backup. A cada 3 meses (sugestão:
primeira semana de jan/abr/jul/out):

1. Baixar o backup mais recente:

   ```sh
   gh run list --workflow=backup.yml --limit 5
   gh run download --name trive-backup
   ```

2. Restaurar em um banco de TESTE vazio (nunca em produção) — o env-file
   informado deve apontar para o banco de teste:

   ```sh
   pnpm tsx scripts/restore-backup.ts trive-backup-AAAA-MM-DD.dump .env.local
   ```

3. Verificar: conectar no banco de teste e conferir que pedidos, clientes e
   produtos recentes estão lá (ex.: rodar o app local apontando para ele).
4. Registrar a data do teste (basta uma linha ao final deste arquivo) e
   descartar o banco de teste.

## Custos mensais e gatilhos de upgrade

| Serviço                            | Custo                              |
| ---------------------------------- | ---------------------------------- |
| Vercel Pro                         | US$ 20/mês a partir do lançamento  |
| Z-API (WhatsApp real)              | ~R$ 100–150/mês                    |
| Supabase, Inngest, Resend, GitHub  | grátis, por enquanto               |

Gatilhos de upgrade:

- **>1.000 pedidos/mês** ou **1º incidente de dados** → Supabase Pro
  (US$ 25/mês).
- **E-mails >100/dia** → plano pago do Resend.

## Quem chamar

Primeiro socorro: o assistente (esta IA) no **Claude Code**, descrevendo o
problema em linguagem natural. Painéis: [vercel.com](https://vercel.com),
[supabase.com](https://supabase.com), [app.inngest.com](https://app.inngest.com),
[github.com/bnigno/trive](https://github.com/bnigno/trive).
