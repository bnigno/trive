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

## Perdi o acesso ao painel

### 1. Esqueci minha senha (self-service)

**/admin/login** → **Esqueci minha senha** (ou **/admin/esqueci-senha**) →
e-mail com link → cria senha nova. O link é `token_hash` verificado em
**/admin/acesso**, então funciona em qualquer aparelho (pedir no computador e
abrir no celular é ok).

- A resposta da tela é **sempre genérica** ("se existir conta, enviamos"),
  inclusive para e-mail inexistente ou acesso desativado — anti-enumeração.
- Limite de **3 pedidos por hora** por conta, contado nos audits
  (`user.password_reset_requested`). Pedido bloqueado não grava audit.
- Não chegou: esperar alguns minutos, olhar spam, conferir o e-mail digitado.
  Persistindo → item 4.

### 2. O dono não consegue entrar

- **Há outro proprietário**: ele resolve em **/admin/usuarios** → pessoa →
  **Redefinir senha** (link de acesso ou senha provisória, ambos com botão de
  copiar na tela). Não depende de e-mail.
- **É o único proprietário** e o e-mail não ajuda — dois quebra-galhos:

  ```sh
  npx tsx scripts/create-admin.ts <arquivo-env> <email> [role] [nome]
  ```

  ou Supabase → projeto de produção → Authentication → Users → e-mail →
  definir senha.

> O script é **legado/emergência**: escreve direto no provedor e no banco, por
> fora de `src/services/users.ts`. Não valida último proprietário ativo, não
> grava audit e o upsert **reativa** quem estiver desativado. Depois do
> incidente, voltar a usar /admin/usuarios.

### 3. Alguém saiu da equipe

**/admin/usuarios** → pessoa → **Desativar**. **Nunca apagar** — e o banco
concorda: `variant_costs.created_by → users.id` é `RESTRICT`, então o DELETE
falharia (e apagar destruiria o rastro de quem lançou cada custo).

- Efeito: banido no provedor **e** `is_active = false`; o guard de
  `services/auth` lê o banco a cada request → a pessoa é barrada **no próximo
  clique** (a tela já renderizada na frente dela continua até ela clicar).
- Reversível: **Ativar** de novo. Redefinir senha exige acesso **ativo**
  (`usuario_inativo`), então a ordem é ativar → redefinir.
- Travas: não dá para desativar/rebaixar o **último proprietário ativo**, nem
  para desativar ou rebaixar a si mesmo.

### 4. O e-mail de recuperação não chega

Depende de `RESEND_API_KEY` + `EMAIL_FROM` (`isEmailConfigured()`). Sem elas,
o self-service fica **indisponível com aviso na tela** — nunca skip silencioso
em autenticação.

- **Saída que funciona sempre**: o dono gera link/senha na hora em
  **/admin/usuarios** → **Redefinir senha**, copia e entrega.
- Para ligar o canal: `docs/setup-externo.md`, seção **Resend**. A mesma
  configuração destrava as confirmações de pedido dos clientes.

### Checklist manual (rodar após mudanças em usuários/permissões)

1. Como dono, criar um usuário **staff** em /admin/usuarios no modo
   **convite** — a tela deve mostrar o link com botão de copiar.
2. Abrir o link em **outro navegador** (ou janela anônima), para não
   aproveitar a sessão do dono.
3. Definir a senha na tela que abrir (/admin/nova-senha).
4. Entrar com o staff: menu **sem** Fornecedores, Preços, Frete, Financeiro,
   Configurações, WhatsApp(config), Relatórios, Cupons, Fila e Usuários; URL
   direta nessas áreas cai em **/admin/sem-acesso**; pedido **sem** margem e
   **sem** taxa do MP.
5. Com o dono (no outro navegador), **desativar** o staff.
6. No navegador do staff, clicar em qualquer link: deve cair em
   **/admin/login?motivo=inativo**.
7. Self-service ponta a ponta: /admin/esqueci-senha com um e-mail real →
   receber → abrir o link → definir senha → entrar. (Só passa com o Resend
   configurado; sem ele, conferir que a tela **avisa** em vez de fingir.)

## Mensagem ou e-mail não chegou

Mensagens e e-mails passam por uma fila com **retry automático** (tentativas
repetidas com espera crescente) — atraso de minutos é normal. Se não chegar:
**/admin/fila** → **Reprocessar** os itens em falha definitiva e ler o motivo
mostrado no item.

E-mail de **recuperação de senha** não passa pela outbox (o payload é uma
credencial e o feedback precisa ser imediato): reprocessar não se aplica — ver
**Perdi o acesso ao painel**, item 4.

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
