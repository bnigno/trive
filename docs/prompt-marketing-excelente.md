# TRIVÉ — marketing nível excelente (WhatsApp + Instagram)

Você está no repositório da TRIVÉ. Quero levar o marketing do sistema a um nível
excelente nos dois canais que a loja usa de verdade: o WhatsApp (a Lia) e o
Instagram (@trive_mfeminine). Não quero "mais uma feature": quero coisas que
uma loja de Belém do nosso tamanho nunca teve, construídas em cima do que já
existe, com a disciplina do CLAUDE.md.

[ANEXO: a imagem de referência — a foto de um moletom infantil esticado na mesa
vira a foto de uma criança vestindo o moletom, fundo bege, luz suave. É esse o
resultado que quero para as nossas peças, só que ainda mais real: parecer foto
boa de celular numa tarde em Belém, nunca "imagem de IA".]

## Como trabalhar comigo

1. Leia `CLAUDE.md` (as 12 regras) e `AGENTS.md` antes de qualquer coisa. As que
   mais importam aqui: todo vendor com rede atrás de adapter com `fake.ts`;
   efeito externo só pela outbox na mesma transação; Zod em toda fronteira;
   dinheiro em centavos; toda mensagem nova em `wa_templates` (com key fixa no
   seed); texto de UI em pt-BR; a loja se chama TRIVÉ ou "a gente/a equipe" —
   nunca "maison" fora da tagline (há teste de guarda no CI).
2. Entre em modo de plano. **Não escreva código antes de eu aprovar o plano.**
3. Passo 0 é obrigatório: um inventário do que já existe. A lista abaixo é o meu
   ponto de partida, mas confira no código — não confie em mim. Para cada ideia
   diga: existe / existe parcialmente (onde) / é novo.
4. Depois do inventário: plano em marcos, PRs pequenos e numerados, cada um
   com migração (se houver), settings novos, templates novos, testes, custo
   estimado em R$/mês e risco. Ordene por impacto ÷ esforço e diga por quê.
5. Cada PR: `pnpm test`, `pnpm typecheck`, `pnpm lint` verdes, e uma revisão
   adversarial sua com pelo menos duas lentes (correção/idempotência/dedupe e
   voz da marca/privacidade/custo) ANTES de me chamar. Depois do commit de
   correção, uma segunda rodada.
6. Ambiente: `.env.local` é o Supabase de DEV. **Nunca toque em
   `.env.prod.local`** nem rode script contra produção sem eu pedir por
   escrito. Próxima migração livre: veja `ls drizzle` (a última é 0054).
7. No fim de cada marco: um roteiro de teste passo a passo para leigo (eu não
   programo) e a lista "o que ficou para o dono" (chaves, créditos, contas,
   decisões).

## O que já existe (confira; não reinvente)

- Post da peça para Instagram: 4:5, story 9:16, carrossel e legenda pronta
  (`services/product-posts.ts`, `core/cards/post.ts`, tela
  `/admin/produtos/[id]/post`), redesenhados pela fila em `product.published`
  e `product.card_refresh` (`services/product-cards-queue.ts`).
- Links de story com funil toques → conversas → pedidos (`/ig/[slug]`,
  `services/campaign-links.ts`, `site_carts.source = 'campaign'`), com
  og:image da peça.
- Story da estreia com silhuetas atrás do véu (`drop-story.ts`,
  `drop-teaser.ts`), lista de espera e convite VIP (`drop-waitlist.ts`,
  `wa.drop_invite`), página `/estreia` e `/lancamento/[token]`.
- Provador TRIVÉ: grupos de WhatsApp com 3 posts rituais por semana, enquetes,
  reações, "@Lia" no grupo e avisos privados com opt-in (`wa-groups.ts`,
  `wa-group-lia.ts`, `/provador`).
- "Quem já vestiu" com consentimento em duas etapas e mimo em cupom
  (`customer-looks.ts`, `look-coupons.ts`, `/admin/produtos/quem-vestiu`).
- Cartela de estilo e quiz (`style-profiles.ts`, `/estilo`), com medidas do
  corpo opcionais e "esquecer".
- Gentilezas da Lia, cupom por atraso, proteção de preço, vale de papel,
  prêmio de indicação (`lia-gifts.ts`, `coupon-notices.ts`, `paper-vouchers.ts`).
- Retornos combinados e sacola parada (`wa-followups.ts`, cron
  `wa-idle-cart-followup`), política única de envio proativo — janela 9–21
  SP, intervalo, adiamento (`wa-send-policy.ts`).
- Voz da curadora: nota em áudio por peça, transcrita, e a Lia manda o áudio
  (`curator-notes.ts`, setting `bot_audio_notes_enabled`).
- Ateliê pelo WhatsApp: a dona manda fotos + recado e nasce o rascunho com o
  cartão da chegada (`atelier.ts`, `atelier-card.ts`).
- Ficha da peça pela foto e reconhecimento da peça na foto da cliente
  (`product-draft.ts`, `photo-match.ts`, `image-fingerprint.ts`; interface
  `SalesAssistant.extractFromPhotos` em `adapters/assistant`).
- "Bom dia" diário para o dono em imagem (`daily-digest.ts`), Central do
  WhatsApp com números e custo (`wa-insights.ts`, `core/ai/model-cost.ts`).
- Edições de Belém com datas da cidade (`city-editions.ts`, setting
  `city_dates`), cartões da edição na caixa, etiquetas, selos e adesivo da
  sacola com QR para a Lia; setting `store_instagram`.
- Adapters existentes: `assistant` (Claude), `transcription` (OpenAI),
  `zapi` (texto, imagem, áudio, lista, enquete, reação, fixar, grupos),
  `storage` (Supabase), `email`, `mercadopago`, `superfrete`, `cep`,
  `geocoding`. **Não existe** gerador de imagem, clima, Status do WhatsApp
  nem API do Instagram.

## Ideia central: a peça no corpo, feita por IA, que não parece IA

Hoje a foto é a peça esticada. Quero que cada peça possa ter, em minutos, fotos
dela no corpo de uma modelo, em cena de Belém, com fidelidade total à peça.

Requisitos:

- **Adapter novo** `src/adapters/image-studio/`: `index.ts` com a interface
  (algo como `generateOnModel({ productImage, scene, model, size }) →
  imagens`), `client.ts` com o vendor, `fake.ts` que devolve a própria foto
  com uma marca visível "FAKE" para o fluxo inteiro rodar em dev e nos testes.
  Candidatos a comparar antes de escolher: Google Gemini 2.5 Flash Image,
  OpenAI `gpt-image-1` (edição com imagem de referência — já existe
  `OPENAI_API_KEY` na Vercel para a transcrição) e um serviço especializado de
  try-on (ex.: FASHN). Critérios: fidelidade da estampa/cor/corte, custo por
  imagem, latência, licença de uso comercial. Recomende UM e deixe a interface
  pronta para trocar. Inspecione a API real (doc/SDK) em vez de chutar.
- **Realismo é a regra, não o enfeite.** Presets de cena com nome da casa
  (varanda com luz de 16h, parede de azulejo, calçada depois da chuva, sala
  clara) e um "prompt de fotografia" fixo no core: luz natural, textura de
  pele real, fios de cabelo soltos, rugas do tecido, fundo com profundidade e
  imperfeição, enquadramento de celular/35 mm, leve grão; proibido pele de
  plástico, simetria perfeita, fundo cinza de estúdio, mãos erradas. Depois,
  pós-processamento com `sharp` (grão sutil, leve vinheta, saturação um pouco
  abaixo, mesmo tamanho/compressão das fotos reais) para o feed ficar
  homogêneo — a foto de IA não pode "saltar" ao lado das reais.
- **Portão de fidelidade automático:** antes de mostrar para mim, a visão que
  já existe (`extractFromPhotos`) compara a foto original com a gerada e
  devolve JSON `{ mesma_peca, cor_ok, estampa_ok, corte_ok, artefatos[],
  nota 0–10 }`. Abaixo do corte, descarta e tenta de novo, com teto de
  tentativas e de custo. Custo de cada geração e de cada julgamento vai para
  o `audit_log`, como a ficha pela foto faz.
- **Modelos da casa:** 3 modelos fixas (referência guardada no Storage), com
  tons de pele e corpos que refletem Belém, para o feed ter consistência de
  marca (a mesma modelo em toda a edição). Nunca parecida com pessoa real,
  nunca rosto ou corpo de cliente.
- **"Veja no seu tamanho":** gerar a mesma peça em corpos P/M/G/GG. Na
  conversa, a Lia pode mandar a peça no tamanho que a cliente disse — e, para
  quem tem cartela com consentimento, na paleta dela. Só mostra; nunca
  guarda nada da cliente na geração.
- **Fluxo no painel:** em `/admin/produtos/[id]`, bloco "Foto no corpo":
  escolher cor (eixo da grade), cena, modelo, tamanho → gerar 3 opções pela
  fila (evento `product.ai_photo`, handler idempotente, dedupe por
  peça+cor+cena+tentativa) → eu escolho → vira `product_images` com coluna
  nova `origin` (`'upload' | 'ai'`, default `'upload'`), pareada à cor,
  `sort_order` depois da foto real → dispara `product.card_refresh` para o
  post/story/carrossel e o cartão da Lia serem redesenhados.
- **Fluxo pelo WhatsApp:** no Ateliê, eu mando a foto da peça com "no corpo"
  e recebo 3 opções; respondo 1/2/3 e está salvo. Reaproveite `atelier.ts`.
- **Onde aparece:** Instagram (post com a foto no corpo de capa e a esticada
  no carrossel) e cartões da Lia sempre; na vitrine só com o setting
  `ai_photos_in_store` (padrão desligado até eu ver a qualidade).
- **Salvaguardas:** `ai_photos_enabled`, cota diária, custo estimado na tela e
  no "Bom dia"; proveniência sempre registrada (`origin` + audit) mesmo que a
  loja não rotule; foto de IA NUNCA entra em "Quem já vestiu" nem se passa
  por depoimento ou cliente real.
- **Antes da UI:** um `scripts/preview-ensaio.ts` no padrão dos `preview-*`
  que gera contra o fake e, com uma flag e teto de custo, contra o vendor
  real com UMA peça, salvando no scratchpad, para eu olhar o resultado antes
  de ligar o resto. Mostre a conta: R$ por foto; por peça com 3 cores × 3
  opções; por mês com 40 peças novas.

## Outras ideias — avalie cada uma, encaixe no que existe, proponha ordem

1. **"Ficou a última" vira story.** O evento `stock.last_unit` já existe; gere
   a imagem 9:16 com link de campanha e mande para o meu WhatsApp pronta para
   postar (como `drop-story.ts` faz para a estreia).
2. **Status do WhatsApp como canal.** Confirme na doc da Z-API o envio de
   status (texto/imagem/vídeo) e acrescente ao adapter (com fake). Todo story
   gerado pelo sistema pode ir também para o Status do número da TRIVÉ, com um
   toque, dentro da janela de envio; quem responde ao status cai na Lia com o
   contexto da peça.
3. **Rota do motoboy vira urgência honesta.** `delivery_runs` +
   `customer_addresses.district`: "hoje o motoboy passa no seu bairro; fecha
   até 14h e recebe hoje" só para quem tem sacola aberta ou conversa quente
   naquele bairro. Opt-in, janela, 1 por semana por cliente, dedupe por corrida.
4. **A chuva de Belém.** Adapter de clima (Open-Meteo, sem chave; fake) para a
   Lia saber "chove às 15h" (aviso de entrega), a pauta do dia sugerir peças e
   um story "tarde de chuva" pronto. Barato e fala a língua da cidade.
5. **Pauta do dia no "Bom dia".** Uma peça para postar hoje, escolhida por regra
   pura no core (estoque bom, margem, sem post há 30 dias, data de Belém
   chegando em `city_dates`, clima), já com post/story/legenda gerados e link
   de campanha criado; eu só toco em compartilhar. Duas legendas por post; o
   link conta qual converteu.
6. **Prova social real no post.** Carrossel que junta a foto da peça com os
   looks aprovados de "Quem já vestiu" e, na vitrine, o número anônimo
   "a Lia mostrou esta peça 14 vezes esta semana" (derivado do `audit_log`
   dos turnos).
7. **Retrospectiva "Minha TRIVÉ".** Cartão compartilhável (engine de cartões)
   com a cartela da cliente, cores mais compradas, a primeira peça; a Lia
   oferece depois da 3ª compra; feito para o story dela marcar
   @trive_mfeminine e voltar como link de campanha.
8. **Depoimento vira cartão.** `delivery_feedback` com nota alta e texto →
   pergunta de consentimento por enquete (`sendPoll`) → cartão de depoimento
   pronto para post/story. Nunca inventado; nome do jeito que ela autorizou.
9. **Espelho do guarda-roupa.** A cliente manda foto de uma peça que já tem
   (de qualquer marca); o `photo-match` não acha no catálogo → em vez de
   "não conheço", a Lia sugere 2 peças que combinam (visão + cartela).
   Ferramenta nova em `core/bot/tools`.
10. **Link na bio vivo.** `/ig` como hub: as últimas peças postadas (registro
    "postei em" no painel), a estreia atual, Provador e Lia; cada toque vira
    `site_carts.source = 'bio'` (hoje só há `pdp`, `cart`, `footer`,
    `campaign`).
11. **"Chegou hoje".** A chegada do Ateliê gera o teaser "chegando" (silhueta
    atrás do véu, `drop-teaser.ts` já faz) e, 24 h depois, a foto no corpo;
    encadeia com a estreia.
12. **Painel `/admin/marketing`.** Um lugar só: pauta do dia, posts gerados e
    "postei em", links e funil, fotos de IA e custo, Status enviados,
    calendário de Belém. Regra 9: a página chama service; componente só
    apresenta.

Proponha pelo menos 3 ideias suas que não estão aqui, com a mesma disciplina
(o que existe, o que falta, custo, risco). Prefiro poucas ideias muito bem
feitas a muitas pela metade.

## O que NÃO fazer

- Não inventar cliente: "Quem já vestiu" continua só com foto real e
  consentida; foto de IA nunca vira depoimento.
- Não usar rosto, corpo ou foto de cliente real para gerar imagem.
- Não publicar automaticamente no Instagram. Não há API do Instagram no
  sistema e não quero agora: post continua "pronto para colar/compartilhar".
  Se quiser propor a Graph API, é um marco à parte, com pré-requisitos e
  custos explícitos, para eu decidir.
- Nenhuma mensagem proativa fora de `wa-send-policy`, sem opt-in
  (`customers.marketing_opt_in` / o sim no Provador) ou sem dedupe no banco.
- Nenhum retry ad hoc (só `core/queue/retry-policy.ts`), nenhum `UPDATE
  status` direto, nenhum SDK de vendor fora de `adapters/`, nenhum
  `eslint-disable` para furar fronteira.
- Não mudar a voz da marca: legenda e mensagens no tom que já existe em
  `core/cards/post.ts` e nos templates; sem hashtag genérica, sem emoji em
  excesso, sem "maison".

## Entregas, nesta ordem

1. Inventário (tabela: ideia / existe? / onde / o que falta).
2. Plano em marcos com PRs numerados, migrações, settings, templates, custo
   R$/mês, riscos e a seção **"Decisões para o dono"** (vendor de imagem e
   orçamento mensal; foto de IA na vitrine ou só IG/WhatsApp; perfil das
   modelos da casa; Status do WhatsApp sim/não; mensagem da rota do motoboy
   sim/não e cadência). Espere minha aprovação.
3. Marco 1 primeiro e sozinho: a foto no corpo de ponta a ponta com o fake +
   o smoke real com 1 peça e teto de custo. Só depois os outros marcos.
4. No fim de cada marco: roteiro de teste para leigo e "o que ficou para o
   dono".
