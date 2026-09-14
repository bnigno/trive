# Runbook TRIVÉ — o que fazer quando algo der errado

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

## Entrega por motoboy: rota do dia e "Saiu"

**/admin/pedidos/rota** lista os pedidos com janela de entrega (faixa
Motoboy em **/admin/frete**) — pagos e os de **dinheiro na entrega** (que
ficam "aguardando pagamento" até o motoboy voltar) — por horário, com
endereço, telefone e o que receber. **Saiu** marca o pedido pago como
enviado; o de dinheiro só ganha a marca de saída e vai para **Na rua** até
você registrar o pagamento no pedido e clicar **Entregue — o motoboy
voltou**. Nos dois casos a cliente recebe "Saiu da maison, chega hoje entre
19h e 21h" (template `order_out_for_delivery`), uma vez só. Janela que já
passou não sai: reagende antes. Pedido que **pagou depois da hora-limite** ou com
janela de ontem aparece marcado com **Reagendar** — a nova janela não avisa a
cliente sozinha: combine pelo link do WhatsApp do card. Template novo em
produção entra com `scripts/sync-seed.ts --templates order_out_for_delivery`.

## Data marcada e Datas da cidade

No checkout a cliente marca **"É para uma data?"** (dia + ocasião) e cada
opção de entrega diz se chega a tempo (Correios em dias úteis, sem os
feriados nacionais fixos; motoboy no dia da janela). O pedido guarda
`needed_by`/`ship_by`; **/admin/pedidos/data-marcada** lista do mais urgente
ao mais folgado com semáforo (vermelho = sai hoje ou atrasou), o dashboard
e o Bom dia contam "precisam sair hoje". **Datas da cidade** (Configurações)
alimenta o selo da home "Círio em N dias · peça até X pelos Correios" — o
prazo é o da faixa de Correios mais lenta em Frete. Template do Bom dia em
produção: `scripts/sync-seed.ts --templates owner_daily_digest --force-templates`
(confira antes se a dona editou o texto).

## Lia e as Edições de Belém

A planta da loja da Lia lista as edições ativas (no ar ou por vir) e ela
filtra com `edicao` em `listar_produtos` quando a cliente cita a ocasião
("me mostra a edição do Círio"); a lista tocável e o cartão saem só com as
peças da edição. O Bom dia ganha "Faltam N dias para a Edição Círio" no topo
da imagem e a linha `{{edicoes}}` na legenda — template em produção:
`scripts/sync-seed.ts --templates owner_daily_digest --force-templates`
(confira antes se a dona editou o texto).

## Lia: janelas do motoboy e data marcada

`cotar_frete` devolve as mesmas opções da sacola do site — Correios por prazo
e o motoboy uma linha por janela ("hoje, 19h–21h — R$ 15,00 (pague até
13h)"). Com `entregar_ate`, cada opção diz "chega dia…". A cliente escolhe
pelo número ou pelo texto ("motoboy 19h") e o pedido nasce com a janela e a
data marcada, iguais aos do site. Janela que passou da hora-limite entre a
cotação e o fechamento: `criar_pedido` recusa e manda cotar de novo. Um
`presente.entregar_ate` no passado não trava a venda (fica informativo).

## Ateliê pelo WhatsApp: fotos + recado viram rascunho de peça

Do **celular da dona** (o número em **Vendedora & WhatsApp › Conexão**, nunca
o número da própria linha — esse chega como `fromMe` e é ignorado), mande as
fotos da peça para o número da maison e, em seguida, um recado com o nome
(texto ou áudio). Em até ~1 minuto ela recebe "Rascunho pronto · Longo Dunas ·
3 fotos" com o link da ficha; a peça nasce em rascunho, com as fotos, e nada
aparece na loja. Regras: cada foto chega num webhook próprio, o lote são as
fotos dos últimos 15 minutos (máx. 3, as mais próximas do recado); a fila
espera 45 s antes de montar, porque a última foto às vezes chega depois do
recado; legenda na foto já vale como recado; **texto solto da dona sem foto
recente segue o fluxo normal** (ela pode testar a Lia como cliente); áudio
dela é sempre Ateliê (sem transcrição configurada, pede o recado por texto);
foto mandada "como documento" não chega — a resposta orienta. Foto expirada
na Z-API, recado sem foto ou erro na montagem viram a mensagem
`owner_atelier_help`; o que deu errado fica em **/admin/fila**
(`wa.atelier_intake`) e na ficha (`atelier_intakes.error_detail`). Interruptor
**Ateliê pelo WhatsApp** na Central; em produção as chaves entram com
`scripts/sync-seed.ts --settings atelier_enabled --templates owner_atelier_draft,owner_atelier_help`.

O recado é interpretado pela inteligência (modelo da setting `bot_model`, a
mesma chave da Anthropic da Lia; centavos por chegada, anotados no audit
`atelier.intake` e na ficha): "chegou o Longo Dunas da Aurora, areia e terra,
do P ao GG, três de cada, custou 120" vira a grade cor × tamanho com SKUs e o
custo por peça em cada variação, a sala, a descrição e o preço sugerido pela
calculadora — a resposta diz "2 cores × 4 tamanhos · 3 de cada (24 peças) ·
custo R$ 120,00 · sugerido R$ 289,90 · Aurora". O **estoque não entra nesse
passo** (a chegada vira compra, com conta a pagar, no passo seguinte do
Ateliê) e o preço sugerido não é aplicado: a dona decide na ficha. Sem chave,
demora (25 s) ou resposta fora do formato, a ficha nasce simples (nome pelo
recado, 1 variação) e a mensagem avisa "sem a grade"; o bloco "Chegou pelo
WhatsApp" na ficha mostra o que foi entendido e os avisos. Template
atualizado em produção com `--templates owner_atelier_draft --force-templates`.

A chegada também **vira compra** no mesmo passo: o fornecedor do recado
("da Aurora") é achado pelo nome (sem acento/caixa; prefixo único) ou criado
na hora e ligado à ficha; a quantidade dita ("três de cada") entra como
`purchase_in` em cada variação com o custo por peça; nasce **uma** conta a
pagar pendente pelo total (o total dito manda quando é ele que se sabe) em
**/admin/financeiro**, ligada ao fornecedor. Sem quantidade não há compra (a
dona lança pelo painel); sem base de custo o estoque entra sem custo e sem
conta; reentrada não dobra nada (chave por chegada + variação). Depois do
"Rascunho pronto" chega um **cartão** noir/ouro com a foto da peça e as três
linhas do resumo (grade, peças · custo, fornecedor · a pagar), legenda com o
link — template `owner_atelier_card`, evento `wa.atelier_card` (2 tentativas;
sem foto na ficha, não há cartão). Produção: migração 0035 e
`scripts/sync-seed.ts --templates owner_atelier_card`.

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

## Foto não sobe ("This page couldn't load" / "a página não carregou")

Na Vercel, cada requisição aceita no máximo **4,5 MB** — o `bodySizeLimit` do
Next não manda nisso. Por isso todo upload do painel (fotos da peça, foto do
pacote, "começar pela foto") é reduzido no navegador (`src/components/admin/shrink-image.ts`,
lado maior 1600 px, JPEG) e vai **um arquivo por requisição**. Se a tela de erro
do navegador voltar a aparecer num upload: algum formulário está mandando
arquivo cru num POST nativo — passe-o pelo `shrinkImage` + envio em JS. HEIC do
iPhone: o Safari abre sozinho; no Chrome/Firefox o `shrinkImage` decodifica com
`heic-to` (libheif em WASM, carregado só quando aparece um HEIC) e converte
para JPEG antes de subir.

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

## Ver visitas e eventos da loja (Vercel Web Analytics)

A loja registra visitas e alguns eventos (peça vista, peça na sacola, checkout iniciado, pedido feito, cartela concluída) sem cookie e sem dado pessoal — os links com token (`/pedido/…`, `/lancamento/…`) chegam ao painel só como `/pedido` e `/lancamento`, e cupons não são enviados.

1. No celular, abra o app da Vercel (ou vercel.com) → projeto **trive** → aba **Analytics**.
2. "Visitors" e "Page Views" mostram quem chegou e por onde (aba **Referrers**: Instagram, WhatsApp, Google).
3. Aba **Events** mostra os eventos da loja — eventos personalizados exigem o plano Pro; no Hobby só as visitas aparecem.
4. Bloqueadores de anúncio derrubam parte da contagem: os números são um piso, não o total.

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
