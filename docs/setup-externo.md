# Setup externo — checklist do dono

Este é o passo a passo do que **só você** (dono das contas) pode fazer. Nada aqui exige programar — é criar contas, copiar chaves e colar no lugar certo. Reserve ~1h. Guarde todas as chaves num gerenciador de senhas (ex.: Bitwarden), nunca em arquivo solto ou WhatsApp.

Convenção de nomes usada abaixo: **trive-prod** (produção, a loja real) e **trive-dev** (desenvolvimento, para testar sem medo).

## 1. GitHub — onde o código mora

1. Crie uma conta em <https://github.com/signup> (se ainda não tiver). Ative a verificação em duas etapas em <https://github.com/settings/security>.
2. Crie um repositório **privado** chamado `trive` em <https://github.com/new> (marque "Private"; não marque nenhuma opção de inicialização).
3. Envie o código: peça ao dev/IA para rodar o push inicial, ou no terminal, dentro da pasta do projeto:

   ```bash
   git remote add origin https://github.com/SEU_USUARIO/trive.git
   git push -u origin main
   ```

## 2. Supabase — o banco de dados (2 projetos)

1. Crie uma conta em <https://supabase.com/dashboard/sign-up> (pode entrar com o GitHub).
2. **Ative MFA na conta**: <https://supabase.com/dashboard/account/security> → Multi-Factor Authentication → adicione um app autenticador (TOTP, ex.: Google Authenticator). O banco de produção estará atrás dessa conta — isso é obrigatório.
3. Crie o projeto **trive-prod**: New Project → região **South America (São Paulo) / sa-east-1** → defina uma senha de banco forte e **guarde-a**.
4. Repita para **trive-dev** (mesma região, outra senha).
5. Para **cada** projeto, copie 4 valores (vai colar na Vercel no passo 3):
   - **DATABASE_URL**: no projeto, clique em **Connect** (topo da página) → aba **Transaction pooler** → copie a URI (ela usa a porta **6543** — tem que ser essa, não a 5432) e troque `[YOUR-PASSWORD]` pela senha do banco.
   - **Project URL** e **anon key**: Settings → API (`NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY`).
   - **service_role key**: na mesma página, em "Project API keys" (`SUPABASE_SERVICE_ROLE_KEY`). Esta chave dá acesso total ao banco — trate como senha máxima.

> **A service_role virou peça do painel de usuários.** Além do acesso ao banco, ela é a credencial que o sistema usa para criar contas de acesso, gerar link de convite/recuperação, definir senha e bloquear quem sai da equipe (`src/adapters/identity/`). Se ela faltar ou estiver errada em Production, **/admin/usuarios e a recuperação de senha param** com o aviso "provedor de acesso não configurado" — e ninguém novo consegue entrar no painel. Ela é de servidor: nunca colar em código de tela (o CI bloqueia).

## 3. Vercel — onde o site roda

1. Crie uma conta em <https://vercel.com/signup> entrando **com o GitHub**.
2. Importe o repositório: <https://vercel.com/new> → selecione `trive` → Deploy (as configurações padrão de Next.js servem).
3. Cadastre as variáveis de ambiente: no projeto → Settings → Environment Variables. Para cada variável do arquivo `.env.example`, crie **duas versões por escopo**:
   - Escopo **Production** → valores do projeto **trive-prod**.
   - Escopo **Preview** (e Development) → valores do projeto **trive-dev**.
   Assim, um deploy de teste nunca encosta no banco real. Preencha já: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL` (o endereço público, sem barra final — em Preview aponte para a URL de preview, senão o link do e-mail leva para a loja real), `ADAPTER_MODE` (`fake` em Preview, `real` em Production), `JOBS_ROUTE_SECRET` (invente uma senha longa aleatória) e as chaves do Inngest (passo 5). O resto entra nas fases futuras.
4. **Plano**: o plano **Hobby (grátis) proíbe uso comercial**. Para desenvolver e testar, Hobby serve; **antes de vender de verdade, faça upgrade para o Pro (US$ 20/mês)** em Settings → Billing.

## 4. GitHub — secret para o backup diário

1. No repositório: <https://github.com/SEU_USUARIO/trive/settings/secrets/actions> → **New repository secret**.
2. Nome: `DATABASE_URL` · Valor: a DATABASE_URL do **trive-prod** (a mesma do passo 2.5).
3. Isso permite que o GitHub Actions faça o backup diário do banco de produção. O restore desse backup será testado na Fase 1.

## 5. Inngest — o executor da fila

1. Crie uma conta free em <https://www.inngest.com/> (pode entrar com o GitHub).
2. Crie um app e copie as duas chaves em <https://app.inngest.com/> (seção Manage → Keys): **Event Key** (`INNGEST_EVENT_KEY`) e **Signing Key** (`INNGEST_SIGNING_KEY`).
3. Cole as duas na Vercel (passo 3.3), escopo Production. Em Preview a fila roda em modo local/fake.

## 6. Resend — o canal de e-mail do sistema

**Por que importa mais do que parece:** sem `RESEND_API_KEY` **e** `EMAIL_FROM` em Production, o sistema **pula todo envio em silêncio**. Nenhum cliente recebe confirmação de pedido, aviso de pagamento aprovado ou de envio — e nada aparece como erro na fila, porque não chega a existir uma tentativa. A recuperação de senha do painel (`/admin/esqueci-senha`) também fica indisponível (essa, sim, avisa na tela: em login, fingir que enviou seria pior).

Divisão de papéis, para não confundir: **Hostinger = caixa humana** (você lê e responde e-mail de cliente); **Resend = envio automático do sistema**. São coisas separadas e convivem no mesmo domínio.

1. Crie a conta em <https://resend.com/signup> (free: 3.000 e-mails/mês, 100/dia — folgado para o volume atual).
2. **Add Domain** → informe o domínio. Prefira um **subdomínio de envio** (ex.: `send.trivemaison.com.br`) em vez do domínio raiz: além de ser a recomendação do Resend, ele ganha SPF próprio e você não precisa mexer no SPF que a Hostinger já usa (veja o aviso abaixo).
3. O Resend mostra os registros DNS a cadastrar. Cadastre-os onde o domínio é gerenciado (**Registro.br**, na zona DNS do domínio), copiando **exatamente** o que a tela do Resend mostra. São de dois tipos:
   - **DKIM** (CNAME/TXT com nomes próprios) — pode ter vários, cada um é independente, **não conflita com nada**. É só colar.
   - **SPF** (TXT começando com `v=spf1`) — este tem regra especial, leia o aviso.
4. Volte ao Resend e clique em **Verify**. A propagação costuma levar minutos (pode chegar a algumas horas).
5. **API Key**: <https://resend.com/api-keys> → Create API Key → permissão *Sending access*. A chave aparece **uma única vez** — guarde no gerenciador de senhas.
6. Cadastre na Vercel (Settings → Environment Variables, escopo **Production**):
   - `RESEND_API_KEY` = a chave criada.
   - `EMAIL_FROM` = remetente **no domínio verificado**, no formato com nome: `TRIVÉ <pedidos@trivemaison.com.br>` (ou `@send.trivemaison.com.br`, se você verificou o subdomínio). Remetente fora do domínio verificado é recusado no envio.
   - Confira também que `NEXT_PUBLIC_SITE_URL` está cadastrada — é ela que monta o link dentro do e-mail de convite/recuperação.
7. Faça um **redeploy** (variável nova só vale para deploy novo) e teste: `/admin/esqueci-senha` com o seu e-mail, ou crie um usuário de teste em `/admin/usuarios` marcando "enviar por e-mail".

> ### Aviso do SPF: é **um registro só**, e ele precisa ser mesclado
>
> O domínio pode ter **apenas um** registro TXT `v=spf1`. Dois registros SPF na mesma zona não somam — a verificação dá erro e **os dois** remetentes passam a cair em spam, inclusive o e-mail que hoje funciona pela Hostinger.
>
> Então, se o registro SPF do Resend for para o **mesmo nome** onde a Hostinger já tem o dela (o domínio raiz), **não crie um segundo**: edite o existente e junte os `include:` num único registro, mantendo o `v=spf1` no começo e o `~all` no fim. O formato é:
>
> ```text
> v=spf1 include:<o-que-a-hostinger-já-tem> include:<o-que-o-resend-pediu> ~all
> ```
>
> Copie os `include:` **do que já está publicado** e **da tela do Resend** — não digite de memória, cada provedor tem o seu. Se você usou o subdomínio de envio do passo 2, este problema não existe: o SPF do Resend fica em `send.` e o da Hostinger continua intocado no raiz.

## 7. Fica para as fases futuras (não faça agora)

| Serviço | Quando | O que será preciso |
| --- | --- | --- |
| Mercado Pago (produção) | Fase 3 | Conta vendedor em <https://www.mercadopago.com.br/developers>, credenciais de produção (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) |
| Z-API + chip dedicado | Fase 4 | Conta em <https://www.z-api.io>, um **chip/número exclusivo** para o WhatsApp da loja (nunca o número pessoal) |
| Sentry | Fase 5 | Conta free em <https://sentry.io> para monitorar erros (`SENTRY_DSN`) |
| UptimeRobot | Fase 5 | Conta free em <https://uptimerobot.com> para avisar se o site cair |

## Custo mensal projetado

| Item | Custo/mês | Observação |
| --- | --- | --- |
| Vercel Pro | US$ 20 (~R$ 110) | Só no lançamento; Hobby grátis proíbe uso comercial |
| Z-API | ~R$ 100–150 | A partir da Fase 4 |
| Supabase | R$ 0 | Free tier cobre o volume atual |
| Inngest | R$ 0 | Free tier |
| Resend | R$ 0 | Free tier (até 3.000 e-mails/mês) |
| GitHub / Sentry / UptimeRobot | R$ 0 | Free tier |
| Mercado Pago | % por venda | Taxa por transação, não mensalidade |
| **Total** | **~R$ 210–260** | No lançamento (Fases 0–3 sem Z-API: ~R$ 110) |

## Bucket `product-images`, o comprovante e a nota da curadora

Conferido em 2026-09-04: o bucket é público, com limite de 10 MB por arquivo.
Desde a nota da curadora (2026-09-12) ele aceita imagens (`image/webp`,
`image/png`, `image/jpeg`, `image/avif`) **e áudio** (`audio/webm`, `audio/ogg`,
`audio/mp4`, `audio/mpeg` — a lista canônica vive em
`src/core/catalog/curator-note.ts`). O comprovante de pagamento
(`receipts/<orderId>/comprovante.jpg`, gerado pelo evento `order.receipt`)
depende de `image/jpeg`; a nota da curadora depende dos áudios.

`scripts/setup-storage.ts` é idempotente: cria o bucket se não existir e, se
já existir, atualiza a lista de formatos. Rodar de novo a cada formato novo:

```text
npx tsx --env-file=.env.prod.local scripts/setup-storage.ts
```

O Supabase compara o mime por igualdade exata (sem `;codecs=`), por isso o
serviço da nota canoniza o que o navegador manda antes de subir.

## 8. OpenAI — a vendedora ouve os áudios (Onda 4)

A Lia transcreve os áudios que as clientes mandam no WhatsApp com a API da OpenAI (modelo `gpt-4o-mini-transcribe`, cerca de US$ 0,003 por minuto de áudio — centavos por mês numa loja pequena). As fotos ela vê com a própria Anthropic, sem chave extra.

1. Crie uma conta em <https://platform.openai.com>, coloque um crédito pequeno (US$ 5 duram meses) e gere uma chave em **API keys**.
2. Cadastre `OPENAI_API_KEY` na Vercel (Production e Preview) — a chave nunca vai para o navegador (o CI bloqueia).
3. Na Central "Vendedora & WhatsApp", o interruptor **"A Lia vê fotos e ouve áudios"** liga e desliga o recurso. Sem a chave, o áudio vira "[a cliente enviou um áudio]" e a vendedora pede para escrever. Ao lado, **"A Lia reconhece a peça na foto"**: foto da própria loja repassada pela cliente é comparada com as fotos do catálogo (impressão digital, sem custo) e, se não bater, com até 8 peças parecidas pela Anthropic — nada de chave extra; a foto continua não sendo guardada (ver "A Lia reconhece a peça na foto" no runbook).

Privacidade: o arquivo de áudio e a foto são processados na hora e não ficam guardados por nós; o texto transcrito fica na conversa como qualquer mensagem.

## 9. SuperFrete — os Correios cotados na hora

Fora da área do motoboy, a sacola e a Lia cotam **PAC e SEDEX** na hora pela SuperFrete (preços já com o desconto da plataforma) e somam o acréscimo de embalagem que a dona define. A cotação é gratuita; paga-se só a etiqueta, quando ela é emitida no painel da SuperFrete.

1. Crie a conta em <https://superfrete.com> (CPF ou CNPJ, sem mensalidade).
2. No painel, em **Integrações → Integrar em Desenvolvedores**, confirme e copie o **token da API** (não expira; se vazar, gere outro no mesmo lugar).
3. Cadastre `SUPERFRETE_TOKEN` na Vercel em **Production** (e Preview, se quiser testar antes) e faça um redeploy. A chave nunca vai para o navegador (o CI bloqueia). Para testar sem cotar de verdade, existe o sandbox (<https://sandbox.superfrete.com>, conta e token próprios) com `SUPERFRETE_BASE_URL=https://sandbox.superfrete.com`.
4. Em **/admin/frete → Correios automático**: informe o **CEP de origem** (de onde os pacotes saem — um CEP real, não o genérico da cidade: a SuperFrete recusa CEP que não existe na base dos Correios), confira o **acréscimo por pedido** (padrão R$ 3,00) e salve. O selo do token mostra ✓ quando a variável existe.
5. Teste sem sair do painel: no mesmo cartão, **Testar cotação** — CEP de destino (ex.: 01310-100) e **Cotar agora**. Deve listar PAC e SEDEX com preço final (já com o acréscimo), o valor da SuperFrete e o prazo. Funciona com o toggle desligado, não grava nada e a mensagem de erro diz o que falta (token ausente, token recusado, CEP inválido). Pelo terminal: `npx tsx --env-file=.env.prod.local scripts/smoke-superfrete.ts --de 66045-335 --para 01310-100`.
6. Ligue o toggle e salve. Confira: sacola com um CEP fora de Belém (ex.: 01310-100) deve mostrar PAC e SEDEX com valor e prazo em dias úteis; no ensaio da Lia, "meu CEP é 01310100" faz o mesmo.

Sem token ou sem CEP de origem, nada muda: os CEPs sem faixa continuam com "frete calculado pela equipe". Uma faixa de Correios **ativa** em /admin/frete vale na frente da cotação automática (a cotação só entra onde nenhuma faixa cobre o CEP). A postagem segue manual: a dona gera a etiqueta no painel da SuperFrete e marca o pedido como enviado.

## 10. FASHN — a peça no corpo (ensaio com modelos da casa)

A foto real da peça (esticada ou em cabide) vira, em segundos, uma foto dela no corpo de uma das três modelos da casa, numa cena de Belém. O vendor é a FASHN, especializada em **try-on**: a peça é transferida para a foto-base da modelo sem redesenhar a estampa — por isso a cor, a estampa e o corte ficam fiéis. Antes de a dona ver, a visão da Anthropic compara a foto real com a gerada (portão de fidelidade) e descarta o que não passar.

Custo: créditos pré-pagos, sem mensalidade. 1 foto econômica = 1 crédito (US$ 0,075); 1 foto em qualidade alta (2K) = 3 créditos. Uma peça com 3 cores × 3 opções sai por volta de R$ 5; 40 peças novas por mês, cerca de R$ 220 (câmbio de referência R$ 5,50). As fotos-base das modelos são feitas uma vez (≈ R$ 40).

1. Crie a conta em <https://app.fashn.ai>, vá em **API** e compre o pacote mínimo (100 créditos = US$ 7,50; os créditos valem 365 dias).
2. Gere uma **API key** e cadastre `FASHN_API_KEY` na Vercel em **Production** (e Preview, se quiser testar antes). A chave nunca vai para o navegador (o CI bloqueia).
3. Antes de ligar qualquer tela, o smoke com UMA peça e teto de custo: `npx tsx --env-file=.env.prod.local scripts/preview-ensaio.ts --real --peca <caminho-da-foto.jpg> --teto-centavos 1000`. Ele grava as opções em `.preview/ensaio/` com o custo de cada uma — é aí que se decide se a qualidade serve.
4. Em **/admin/produtos/modelos-da-casa**, gere e escolha a foto-base de cada modelo em cada cena (uma vez). Depois, na peça, o bloco **"Foto no corpo"** gera 3 opções e você escolhe a que entra.
5. Os interruptores ficam na Central "Vendedora & WhatsApp": **"Foto no corpo"** (liga a geração) e **"Foto no corpo na vitrine"** (desligado, a foto de IA aparece só no post do Instagram e nos cartões da Lia). A cota diária e a qualidade padrão ficam em /admin/configuracoes.

Sem a chave, o bloco avisa e nada é gerado; dev e testes usam o gerador fake (devolve a própria foto com a faixa "FAKE"). Toda geração, julgamento e escolha fica registrada com custo em `audit_log`; a foto gerada tem `origin = 'ai'` em `product_images` e nunca entra em "Quem já vestiu".

## 11. Aviso no celular com o painel fechado (Web Push)

O painel avisa de mensagem nova no WhatsApp mesmo fechado — no celular (instalado na tela de início) e no Chrome do computador. É o Web Push do próprio navegador: sem serviço pago, sem app na loja.

1. Gere o par de chaves **uma única vez**: `npx web-push generate-vapid-keys`. Guarde as duas linhas (pública e privada); trocar as chaves depois desliga o aviso em todos os aparelhos até cada um religar.
2. Cadastre na Vercel (Production e Preview): `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` e `WEB_PUSH_SUBJECT` (`https://trivemaison.com.br` ou `mailto:contato@trivemaison.com.br`). Redeploy.
3. Em cada aparelho: painel → sino no rodapé do usuário → **Aviso neste aparelho (painel fechado)**. O navegador pede permissão nessa hora.
4. **iPhone**: antes de ligar, adicione o painel à tela de início (Safari → Compartilhar → Adicionar à Tela de Início) e ligue **de dentro do app** — fora dele o iPhone não recebe aviso nenhum (regra da Apple, iOS 16.4+). **Android**: funciona no Chrome direto; instalar é opcional.
5. Como funciona: cada mensagem recebida gera no máximo um aviso por conversa a cada 2 minutos; quem já abriu a conversa não recebe; com o painel visível na tela, o aviso não aparece (o toast e o som do painel já avisaram); tocar no aviso abre a conversa. Inscrição que morreu (app apagado, permissão revogada) some sozinha na primeira falha.
