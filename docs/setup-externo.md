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
