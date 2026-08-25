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

## 3. Vercel — onde o site roda

1. Crie uma conta em <https://vercel.com/signup> entrando **com o GitHub**.
2. Importe o repositório: <https://vercel.com/new> → selecione `trive` → Deploy (as configurações padrão de Next.js servem).
3. Cadastre as variáveis de ambiente: no projeto → Settings → Environment Variables. Para cada variável do arquivo `.env.example`, crie **duas versões por escopo**:
   - Escopo **Production** → valores do projeto **trive-prod**.
   - Escopo **Preview** (e Development) → valores do projeto **trive-dev**.
   Assim, um deploy de teste nunca encosta no banco real. Preencha já: `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADAPTER_MODE` (`fake` em Preview, `real` em Production), `JOBS_ROUTE_SECRET` (invente uma senha longa aleatória) e as chaves do Inngest (passo 5). O resto entra nas fases futuras.
4. **Plano**: o plano **Hobby (grátis) proíbe uso comercial**. Para desenvolver e testar, Hobby serve; **antes de vender de verdade, faça upgrade para o Pro (US$ 20/mês)** em Settings → Billing.

## 4. GitHub — secret para o backup diário

1. No repositório: <https://github.com/SEU_USUARIO/trive/settings/secrets/actions> → **New repository secret**.
2. Nome: `DATABASE_URL` · Valor: a DATABASE_URL do **trive-prod** (a mesma do passo 2.5).
3. Isso permite que o GitHub Actions faça o backup diário do banco de produção. O restore desse backup será testado na Fase 1.

## 5. Inngest — o executor da fila

1. Crie uma conta free em <https://www.inngest.com/> (pode entrar com o GitHub).
2. Crie um app e copie as duas chaves em <https://app.inngest.com/> (seção Manage → Keys): **Event Key** (`INNGEST_EVENT_KEY`) e **Signing Key** (`INNGEST_SIGNING_KEY`).
3. Cole as duas na Vercel (passo 3.3), escopo Production. Em Preview a fila roda em modo local/fake.

## 6. Fica para as fases futuras (não faça agora)

| Serviço | Quando | O que será preciso |
| --- | --- | --- |
| Mercado Pago (produção) | Fase 3 | Conta vendedor em <https://www.mercadopago.com.br/developers>, credenciais de produção (`MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`) |
| Resend + domínio | Fase 2–3 | Conta em <https://resend.com>, domínio próprio verificado (registros DNS) para enviar e-mail como @suamarca |
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
