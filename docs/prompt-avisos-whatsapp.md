# TRIVÉ — toda mensagem do WhatsApp acende no painel, como o e-mail

Quero que qualquer mensagem que chegue no WhatsApp da loja se destaque no
painel do mesmo jeito que o e-mail se destaca hoje: eu abro qualquer página
do admin e vejo, sem procurar, que chegou coisa nova. Hoje isso só acontece
quando a Lia transfere a conversa para mim — mensagem que ela está
atendendo não acende nada fora da página de conversas.

## Como trabalhar comigo

1. Leia `CLAUDE.md` (as 12 regras) e `AGENTS.md`. Aqui pesam mais: regra 9
   (página chama service, componente só apresenta — a contagem nasce em
   `services/`, nunca no componente); regra 7 (Zod no poll); texto em pt-BR;
   a loja é TRIVÉ, nunca "maison" (teste de guarda no CI).
2. Comece pelo inventário: confirme no código o que eu descrevo abaixo e me
   diga o que está diferente. Depois um plano curto (uma tela) e espere meu
   OK antes de codar.
3. Um PR para o painel (Marco 1). O celular (Marco 2) só se eu aprovar, em
   PR separado. `pnpm test`, `pnpm typecheck`, `pnpm lint` verdes e uma
   revisão adversarial sua (bipe duplo? contagem errada? custo de poll na
   Vercel?) antes de me chamar.
4. `.env.local` é o Supabase de DEV; não toque em `.env.prod.local`.

## O que já existe (confira)

- Crachá do menu **Conversas**: `src/app/admin/(protected)/wa-nav-badge.tsx`
  faz poll em `/admin/whatsapp/conversas/poll?light=1` a cada 25 s (recuo até
  100 s) e mostra `humanCount + suggestionCount`. `humanCount` vem de
  `countConversationsAwaitingOwner` em `services/wa-conversations.ts`, que
  só conta `status = 'human'` com mensagem recebida ainda não vista. É esse
  o buraco: conversa em atendimento da Lia com mensagem nova não conta.
- Crachá do menu **E-mails**: `emails/email-nav-badge.tsx` mostra
  `awaitingCount` (toda thread aguardando resposta). É a referência do
  comportamento que quero.
- Dentro de `/admin/whatsapp/conversas`: `unreadCount` por conversa (a
  partir de `wa_conversations.owner_last_seen_at`), negrito e número ouro em
  `conversation-item.tsx`, filtro "Não lidas", título da aba
  "(N) Conversas" e toast/bipe em `chat-shell.tsx` quando a aba está oculta.
  Poll rápido (3 s → 30 s) em `use-chat-poll.ts`.
- Aviso sonoro e de área de trabalho: `use-notify.ts` (prefs em
  `localStorage`, som ligado e desktop desligado por padrão), ligado só na
  cabeçalho da conversa (`thread-header.tsx`). Toasts: `handoff-toast.tsx`.
- "Atenção agora" no início (`dashboard-attention.ts`): hoje só e-mails e
  rota — não tem WhatsApp.
- Abrir a conversa marca como vista (`owner_last_seen_at`). Não há service
  worker nem push; o manifest PWA existe (`src/app/manifest.ts`).
- Já existe aviso no MEU WhatsApp para alguns eventos (`wa.owner_forward`).
  Não é isso que estou pedindo; é o painel.

## O que quero — Marco 1 (painel)

1. **Crachá do menu conta toda mensagem nova.** Número = conversas com
   mensagem recebida que eu ainda não vi, em QUALQUER status (Lia atendendo,
   transferida, fechada que recebeu mensagem). Conversa de avisos internos
   (`isOwnerNotices`) fica de fora — confirme como ela é identificada. A cor
   diz a urgência: ouro quando pelo menos uma está esperando por mim
   (`human`), neutra quando são só mensagens que a Lia está cuidando. As
   sugestões do copiloto continuam no mesmo crachá, como hoje.
2. **Título da aba de qualquer página do admin**: "(N) TRIVÉ" (o mesmo padrão
   do "(N) Conversas"), sem brigar com o título que a página de conversas já
   escreve.
3. **Aviso de qualquer página**: mensagem nova → toast com nome/telefone e
   prévia + bipe (e aviso de área de trabalho se eu ligar), fora da página de
   conversas — dentro dela o `chat-shell` já cuida; não pode haver bipe nem
   toast duplo. Uma vez por mensagem, nunca no primeiro poll depois de abrir
   a página.
4. **"Atenção agora" no início** ganha a linha "N conversas com mensagem
   nova" (e, separada, "N esperando por você"), com link para o filtro
   "Não lidas".
5. **As preferências de som/área de trabalho** passam a ficar num lugar que
   vale para o admin inteiro (pode continuar no `localStorage`), com o pedido
   de permissão do navegador feito num toque meu, nunca automático.
6. **Ritmo**: proponha a cadência do poll leve (hoje 25 s) pensando em custo
   de função na Vercel × demora percebida. Quero sentir "na hora"; diga o que
   custa 10 s contra 25 s.
7. **Marcar como lida** continua sendo abrir a conversa. Acrescente "marcar
   todas como lidas" no filtro "Não lidas" se for barato.

Onde mexer (confirme): o service novo/ajustado em `services/wa-conversations.ts`
(ex.: contagem de conversas com mensagem não vista, por status), o poll
leve devolvendo os dois números, o schema Zod dos dois lados, o crachá, o
título, o toast fora da página e o dashboard. Testes em `tests/services/`
(contagem por status, avisos internos de fora, `owner_last_seen_at` zera) e
`tests/app/` (parse do poll).

## Marco 2 (celular) — só com meu OK

Como o e-mail do celular: aviso mesmo com o painel fechado. Isso é Web Push
com service worker + PWA instalada. Antes de propor, responda: o que
funciona no iPhone (precisa estar na tela de início), o que precisa
(chaves VAPID, tabela de inscrições, adapter `adapters/push` com `fake.ts`,
evento na outbox disparado na mesma transação da mensagem recebida — regra
5), custo e risco. Se for grande demais, diga; a alternativa barata é
estender o `wa.owner_forward` para "mensagem nova" com uma cadência que não
vire spam.

## Entregas

1. Inventário (o que existe / onde / o que falta) e plano curto.
2. PR do Marco 1 com testes.
3. Roteiro de teste para leigo: como provoco uma mensagem nova em dev (há o
   adapter fake da Z-API e scripts `demo-*`/`ensaio-vendedora.ts`), o que
   deve acender em cada lugar, o que deve ficar mudo.
4. Proposta do Marco 2 com decisões para mim.
