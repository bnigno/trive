# Fase 0 — Fundação

A Fase 0 não entrega nenhuma tela de loja. Ela entrega a **infraestrutura que torna todas as outras fases seguras**: se algo quebrar da Fase 1 em diante, é a Fase 0 que garante que dá para ver, reverter e recuperar.

## O que a Fase 0 entrega

- **Projeto Next.js estruturado em camadas** (`core/ → services/ → adapters/ → db/ → queue/ → app/`) com lint de fronteiras que impede importação na direção errada.
- **Banco de dados com migrações versionadas** (Drizzle): tabelas de fundação `users`, `settings`, `audit_log`, `outbox_events` (fila de saída) e `inbound_events` (webhooks recebidos).
- **Fila com outbox**: o padrão que garante que nenhum e-mail/WhatsApp/cobrança se perde nem duplica — gravado no banco na mesma transação da mudança de estado, executado pelo Inngest, com retry e DLQ (eventos mortos) visíveis no admin.
- **Login (Supabase Auth)** com papéis `owner`/`staff` e admin protegido.
- **Adapters com fake**: todo serviço externo tem uma versão falsa para desenvolver e testar sem gastar dinheiro nem enviar mensagem real (`ADAPTER_MODE=fake`).
- **CI no GitHub Actions**: typecheck + lint + testes em todo PR; checagem de migração destrutiva sem aprovação; deploy só passa se o CI estiver verde.
- **Backup diário automático** do banco de produção via GitHub Actions (restore será ensaiado na Fase 1).
- **Deploy contínuo na Vercel** com ambientes separados (Preview usa banco dev, Production usa banco prod) e rollback em 1 clique.
- **Documentação**: `CLAUDE.md` (guia para IA), `README.md` (dono + dev), `docs/setup-externo.md` (checklist de contas).

## Critério de pronto (demonstrável, não "quase")

A Fase 0 só está pronta quando **todas** as quatro demonstrações abaixo acontecem de verdade:

1. **Login no celular em produção** — abrir a URL de produção no celular, fazer login e ver a tela do admin.
2. **Mudança trivial no ar em menos de 5 minutos** — editar um texto, commit, push: o site de produção atualiza sozinho em < 5 min.
3. **Backup diário rodando** — o GitHub Actions mostra o job de backup executado nas últimas 24h, com o arquivo gerado.
4. **CI vermelho bloqueia deploy** — abrir um PR com um teste quebrando de propósito e confirmar que o merge/deploy fica bloqueado até consertar.

Se alguma das quatro não puder ser demonstrada ao vivo, a Fase 0 não acabou.

## O que vem depois

| Fase | Entrega |
| --- | --- |
| 1 | ERP: produtos, estoque (ledger), pedidos manuais, restore de backup ensaiado |
| 2 | Loja: catálogo, carrinho, checkout com CPF |
| 3 | Mercado Pago (Checkout Pro) + fila em produção |
| 4 | WhatsApp (Z-API): notificações automáticas |
| 5 | Operação: Sentry, UptimeRobot, CSV mensal para o contador |
