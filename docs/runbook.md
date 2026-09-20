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
repetidas com espera crescente). O normal é sair em segundos (quem enfileira
avisa o executor na hora); o cron de 1 minuto é a rede de segurança, então
um atraso de até um minuto ainda é normal — minutos seguidos, não. Se não
chegar: **/admin/fila** → **Reprocessar** os itens em falha definitiva e ler
o motivo mostrado no item.

Sinais que a cliente vê enquanto a Lia pensa: ✓✓ azul na mensagem dela assim
que o turno começa (só quando é a Lia que vai responder — nunca em conversa
"com você" nem em copiloto) e "digitando…" por 1–3 s antes de cada balão
("gravando áudio…" antes da nota da curadora). A Z-API não tem um
"digitando" avulso: o status só aparece nos segundos antes de a mensagem
ser entregue. Os segundos ficam em `src/core/bot/reply.ts`. Detalhe de
medição: "enviado" no painel é o momento em que a Z-API aceitou a mensagem
na fila dela — a entrega real vem 2–4 s depois (o "digitando" + 1 s).

Quanto a Lia demora: **Vendedora & WhatsApp → "Tempo de resposta"** mostra a
mediana e o p90 de mensagem → primeiro balão nos últimos 7 dias, e onde o
tempo foi (fila · preparo · modelo · entrega). Fila alta = o executor
(Inngest) não está recebendo o aviso ou a função está caindo; modelo alto =
a API da Anthropic lenta (vale testar o Haiku no Ensaio); entrega alta =
Z-API lenta.

E-mail de **recuperação de senha** não passa pela outbox (o payload é uma
credencial e o feedback precisa ser imediato): reprocessar não se aplica — ver
**Perdi o acesso ao painel**, item 4.

## Entregue com foto

No pedido enviado (Correios ou motoboy que saiu) ou pago para entrega em
mãos, o card **Entrega** (e a **Mesa de entrega**, /admin/pedidos/entregar,
no celular) abre a câmera: foto do pacote na mão de quem recebeu, "recebido
por" (só o primeiro nome vai adiante) e o pedido vira **entregue** pela
máquina de estados. A cliente recebe a foto com a legenda "seu pedido foi
entregue hoje às 17:42, recebido por Maria" (template `order_delivered`,
evento `order.delivered`, uma vez, só com opt-in) e a foto vira o passo
"Entregue" da página pública do pedido. **Marcar como entregue** sem foto
(pelo rastreio dos Correios) continua existindo e, como antes, não manda
nada — a hora do clique não é a da entrega. Refazer a foto troca a imagem
sem reenviar. A câmera aparece no pedido enviado, no pago em dinheiro na
entrega e no motoboy que já saiu; pedido pago pelos Correios embala primeiro. Produção: migração 0037 e
`scripts/sync-seed.ts --templates order_delivered`.

**Chegou!** — pelos Correios a cliente confirma sozinha: na página pública do
pedido enviado há o botão **Chegou!** (quem tem o link marca; o pedido vira
entregue, `delivery_confirmed_by = customer`, e ela recebe o texto de
`order_delivered` sem hora) e, no WhatsApp, se ela disser "chegou"/"recebi",
a Lia chama `confirmar_entrega` (só pedido **enviado** da cliente daquela
conversa; com dois enviados ela pergunta qual; `delivery_confirmed_by = lia`)
e responde "Que bom que chegou 🤎" — nesse caso a resposta da Lia é o aviso,
nada mais sai pela fila. A Mesa de entrega e o card do dashboard destacam os **enviados há
7+ dias sem confirmação**: confira o rastreio ou chame no WhatsApp.

**Chegou bem?** — um dia depois da entrega (das 9h às 21h; fora disso fica
para a abertura da janela), a cliente recebe UMA lista tocável: Amei · Ficou
grande · Ficou pequeno · Veio com defeito · Quero falar com alguém. Uma vez
por pedido, só com opt-in; o interruptor **Chegou bem?** fica na Central. O
toque volta pelo webhook (`feedback:<resposta>:<pedido>`): **grande/pequeno**
caem na Lia, que agradece, ajusta a cartela e transfere a troca com resumo;
**defeito** e **falar** vão direto para você (conversa em "com você"). A
ficha do pedido mostra o estado (card **Chegou bem?**); a ficha da peça ganha
**Caimento pelas clientes** (por tamanho; uma opinião por cliente; peça sem
eixo de tamanho conta como "único") e, a partir de 3 clientes com 60% na
mesma direção, a vitrine avisa "Pelas clientes, o M tende a vestir pequeno".
Se ela tocar de novo com outra opção, a última vale (a ficha e a conversa
ficam iguais). Se a pergunta não sair (WhatsApp fora do ar, número sem
WhatsApp), a ficha continua "ainda não perguntado" — nada fica "perguntado"
sem ter saído. Produção: migração 0038 e
`scripts/sync-seed.ts --settings feedback_ask_enabled --templates delivery_feedback_ask`.

**Quem já vestiu** — quando a cliente manda uma foto DELA usando uma peça
que comprou, a Lia elogia e chama `registrar_foto_com_a_peca`: a foto do
turno vira uma linha em `customer_looks` (com o pedido, quando existe) e a
fila (`wa.customer_look_card`) baixa a foto da Z-API, normaliza (≤ 1600 px,
JPEG sem EXIF), guarda em `looks/<id>/`, desenha o cartão **"Ana veste
Longo Dunas"** (kind `customer_look`) e manda para ela, seguido da lista
tocável **"Posso mostrar na página?"** (Sim, pode / Prefiro que não). O toque
volta pelo webhook (`look:sim|nao:<id>`): grava o consentimento e sai uma
confirmação curta pela fila — sem turno da Lia. Só entra na vitrine
(**Quem já vestiu** na página da peça, com o primeiro nome) com o **"sim"
dela E a sua aprovação** em **/admin/produtos/quem-vestiu** (o painel avisa
"Fotos aguardando aprovação"). Recusar é final; **Retirar** tira da vitrine
para sempre. A cliente retira quando quiser ("tira minha foto" → a Lia chama
`retirar_minha_foto`, pelo telefone E pelo cadastro dela) e "Esquecer tudo"
na ficha da cliente no painel também retira; pelo site, "esquecer minha
cartela" NÃO mexe nas fotos (o token da cartela não prova posse do número).
Retirar apaga `photo.jpg` e `card.jpg` do bucket e pede a revalidação da
página da peça pela fila (`store.revalidate`). Se ela tocar "Prefiro que não"
depois do "sim", a última resposta vale e a foto sai da página na hora. A
mesma foto nunca vira duas linhas (UNIQUE por mensagem). Foto de cliente é
dado pessoal: bucket público com caminho por uuid, nunca listado; o
interruptor **Quem já vestiu** fica na Central. Produção: migração 0039 e
`scripts/sync-seed.ts --settings customer_looks_enabled`.

**Retorno combinado** — quando a cliente adia ("vou pensar", "me chama
amanhã às 10"), a Lia pergunta em uma frase se pode chamá-la e quando; só
com o **sim** dela chama `agendar_retorno` (o executor ainda confere que a
última mensagem dela parece um sim; horário entre 9h e 21h de São Paulo —
fora disso ajusta para a abertura —, de 30 minutos a 7 dias). A linha vai
para `wa_followups` e o evento `wa.bot_followup` fica na fila para o horário.
No horário roda o **turno proativo** (`runScheduledBotTurn`): mesmos
bloqueios do turno normal (conversa com você, fechada, silenciada, Lia
desligada, WhatsApp desligado), mais **SAIR** (cancela na hora, com ou sem
cadastro), **ela já voltou** por conta depois do combinado (passada uma
hora do sim — cancela como "superada"), **tarde demais** (mais de 6 h da
hora: não chama) e **fora da janela** (re-enfileira para a abertura). Modelo
fora do ar tenta 3 vezes e desiste com o motivo; nada fica "agendado" para
sempre. No turno proativo a Lia não agenda outro retorno (precisa de um sim
novo). A mensagem sai marcada no painel
como "Lia · chamou como combinado" e no histórico da Lia como "[você chamou
como combinado]". O painel da conversa mostra **Retorno combinado** com
**Cancelar retorno** e os últimos encerrados com o motivo; agendar de novo
substitui o anterior. Produção:
migração 0040; sem template nem setting novos.

**Modo copiloto** — em **Vendedora & WhatsApp › Modo da vendedora** (ou
no menu de uma conversa: *Só sugerir nesta conversa* / *Deixar responder
sozinha aqui* / *Voltar ao modo da loja*), cada mensagem da cliente vira um
cartão de sugestão na conversa (balões da Lia, chips de lista/foto, o que
ela consultou) com **Enviar**, **Editar e enviar** e **Descartar**. Nada sai
sem você; a sugestão editada vai sem os anexos da Lia. O badge do menu e o
toast avisam "A vendedora sugeriu uma resposta"; no seu WhatsApp chega um
aviso por conversa a cada meia hora, no máximo. Ferramentas com efeito
(pedido, Pix, reserva, aviso, transferência, retorno, foto, entrega) não
rodam em copiloto — a Lia diz que a equipe cuida; para fechar a venda,
volte a conversa para *sozinha* ou faça pelo painel. Consultas e caderninho
(sacola, cartela, nota) continuam. Responder à mão em copiloto NÃO assume a
conversa (ela continua sugerindo); a nova mensagem da cliente, a sua resposta à mão, assumir a conversa ou
voltar para "sozinha" superam a sugestão pendente (o cartão mostra "há X
min"); o aviso no seu WhatsApp é por balde de meia hora do relógio. O retorno combinado em
copiloto também vira sugestão. Produção: migração 0041 e
`scripts/sync-seed.ts --settings bot_mode`.

**Retomada de sacola parada** — na ficha da vendedora, **Retomar sacola
parada após (horas)** (0 = desligado). A cada hora (`wa-idle-cart-followup`,
`7 * * * *`), quem tem peças na sacola da Lia, sumiu há N horas depois de
ela responder, tem cadastro com opt-in e não fez pedido depois ganha UMA
retomada (`wa_followups` kind `idle_cart`, uma vez por conversa, para
sempre), agendada para agora na janela (fora dela, para a abertura). Só
sacolas paradas há no máximo N horas + 7 dias (ligar o recurso não varre o
histórico); "a Lia respondeu por último" precisa ser a Lia de verdade
(aviso automático não conta); com a Lia ou o WhatsApp desligados a varredura
não agenda. **Na hora de mandar tudo é reconferido**: qualquer mensagem
dela depois do agendamento, sacola esvaziada, pedido feito (site ou Lia),
opt-in retirado ou recurso desligado (0 h) cancelam com o motivo no painel.
No horário a Lia manda uma mensagem leve retomando a sacola — sem desconto
inventado; em copiloto vira sugestão "(retomada da sacola)". Só a sacola da
Lia (a sacola do site não passa pelo caderninho). Depois do deploy, registrar
a função nova no Inngest: `curl -X PUT https://trivemaison.com.br/api/inngest`.
Produção: `scripts/sync-seed.ts --settings bot_idle_cart_followup_hours`.

**Vai me servir?** — na página de uma peça com tabela de medidas, quem tem
a cartela de estilo no navegador toca **Vai me servir?**: na primeira vez
informa busto, cintura e quadril (em cm; ficam na cartela, em coluna
própria, uma vez só) e depois lê na hora o veredito por tamanho — "o P
aperta na cintura; no M fica certo (busto 6 cm de folga…); no G fica
fluido. Eu iria de M." A regra é de folga em cm (aperta < 0; marca 0–3;
certo 4–10; fluido 11–18; folgado > 18; o pior ponto decide) e a
recomendação segue o caimento da cartela (justo/fluido/tanto faz). Peça só
com comprimento na tabela não compara. "Apagar minhas medidas" apaga só as
medidas; "esquecer a cartela" apaga tudo. Os números NUNCA entram no
histórico da Lia, no painel ou na trilha — só o fato de existirem ("medidas
guardadas"). Tabela "a meio" (largura da peça deitada, ex.: busto 47) é
dobrada antes de comparar — a convenção é da tabela inteira. As medidas têm
credencial própria: só o aparelho que gravou (e a vendedora, pelo WhatsApp)
lê, troca ou apaga; o token da cartela sozinho não basta. Pela Lia: "o M me serve?" → `sugerir_tamanho`
(folga por tamanho e o recomendado); sem medidas ela pede busto, cintura e
quadril e guarda com `atualizar_cartela.medidas` (coluna própria; `anotar`
recusa medidas; "apaga minhas medidas" → `medidas.apagar`). Gravação pela
Lia ou pelo painel gira a credencial do site (quem tivesse semeado medidas
com o telefone dela perde o acesso). Contornos abaixo de 60/50/60 cm são
recusados (numeração de roupa não é medida). Atenção (decisão do dono
pendente): quem sabe o telefone pode gravar as PRIMEIRAS medidas de uma
cartela sem medidas pelo quiz/site — a cliente apaga pela Lia. No quiz
`/estilo`, o sétimo passo "Suas medidas (opcional)" guarda as três medidas
junto com a cartela ("Pular" em destaque); a tela "A sua cartela" mostra
"Medidas guardadas · Apagar minhas medidas" (só no aparelho que gravou).
Produção: migração 0042; sem setting.

**A Lia manda a voz da curadora** — quando a peça tem a nota da curadora em
áudio (gravada na ficha da peça) e a cliente pergunta de tecido, caimento
ou calor (ou pede para ouvir), a Lia chama `enviar_nota_da_curadora`: o
áudio sai como **mensagem de voz** no WhatsApp dela (Z-API `POST
/send-audio` com a URL pública do bucket, `waveform`), logo DEPOIS do texto
("segue a voz dela" e aí o áudio — lista e foto continuam antes do texto),
com dedupe por turno (o retry da fila não repete). "Uma vez por peça na
conversa" é decidido pelo que de fato saiu (linha `audio` `sent` na
conversa): áudio que o provedor recusou pode ir de novo, áudio aprovado no
copiloto conta, sugestão descartada não conta; "manda de novo" →
`reenviar: true`, no máximo 2 envios da mesma voz por conversa. Na
conversa do painel a mensagem aparece como "🎤 Mensagem de voz" com o
player; no ensaio, como bolha com o player; em copiloto vai junto da
sugestão e sai quando a dona aprova — editada, só o texto. O interruptor
**A Lia manda a voz da curadora** fica na Central (setting
`bot_audio_notes_enabled`, ausente = ligado); desligado, `detalhar_produto`
volta a apontar o link da página e a Lia cita só a nota escrita. Com o
áudio a Lia NÃO cita a nota escrita (a voz responde); o link da página
segue no texto da ferramenta como plano B. Falha do envio é melhor
esforço: o texto segue, a mensagem fica `failed` na conversa e o histórico
da Lia diz que a voz NÃO chegou (no próximo pedido ela manda de novo). O
áudio é o arquivo gravado no navegador (webm/opus no Chrome, m4a no Safari)
— se a Z-API recusar o formato, grave ou envie um mp3/m4a na ficha da peça
(o campo aceita upload). Limite conhecido (pré-existente, vale para lista e
foto): a mídia sai dentro da transação do turno; se um balão de TEXTO falhar
depois de uma mídia já entregue, o turno aborta e o retry reenvia a mídia —
por isso a voz vai por último. Produção: sem migração;
`scripts/sync-seed.ts --settings bot_audio_notes_enabled`.

## Frete: motoboy na região de Belém, Correios sob consulta no resto

Decisão da dona (2026-09-17): em **Belém (com Icoaraci, Outeiro e
Mosqueiro), Ananindeua, Marituba, Benevides, Santa Bárbara, Santa Izabel e
Castanhal** a entrega é **só por motoboy**; no resto do Brasil é pelos
**Correios com o frete calculado pela equipe**. Como funciona:

- **Onde há faixa de motoboy para o CEP, só o motoboy aparece** (site e Lia;
  regra `motoboyExclusive` em `src/core/shipping/delivery-windows.ts`) — as
  faixas de Correios valem só para CEPs sem motoboy. Uma faixa por cidade em
  **/admin/frete**, tipo Motoboy, mesmas janelas; o nome ("Motoboy Belém") é
  o que a cliente lê e monta a frase "Belém, Ananindeua e Castanhal".
- **Sem faixa para o CEP**: a sacola e o checkout mostram "a entrega é pelos
  Correios e o frete é calculado pela nossa equipe" com o botão **Falar com a
  Lia**, que leva a sacola **e o CEP** na mensagem. A Lia (`cotar_frete` sem
  opção) explica, confirma a sacola e o endereço e **transfere para a
  equipe** com o resumo; a equipe cota no site dos Correios e fecha por lá
  (pedido pelo painel com o valor do frete, ou pela conversa). A Lia nunca
  inventa valor nem cria o pedido sem cotação (regra 26 do prompt).
- **Faixas**: `npx tsx scripts/frete-motoboy-regiao.ts` (simulação;
  `--apply` grava com auditoria no nome do dono) cria as cidades que faltam
  copiando preço, peso e janelas da "Motoboy Belém" e desliga a "Entrega
  padrão (todo o Brasil)". Preço por cidade se ajusta depois no painel.
  Faixas de CEP: Belém 66000-000–66999-999 · Ananindeua 67000-000–67199-999 ·
  Marituba 67200-000–67299-999 · Castanhal 68740-000–68749-999 · Santa Izabel
  68790-000–68794-999 · Benevides 68795-000–68797-999 · Santa Bárbara
  68798-000–68798-999.
- **Cotação automática (SuperFrete), desde 2026-09-19**: com o toggle de
  **/admin/frete → Correios automático** ligado, `SUPERFRETE_TOKEN` na Vercel
  e o CEP de origem preenchido, os CEPs **sem nenhuma faixa** (e sem motoboy
  ativo cobrindo o CEP) recebem **PAC e SEDEX** cotados na hora, já com o
  acréscimo de embalagem (`correios_surcharge_cents`, padrão R$ 3,00). Uma
  faixa de Correios ativa continua mandando: a cotação só entra onde o funil
  de faixas volta vazio. As cotações ficam em `shipping_quotes` (uma linha
  por serviço, `batch_id` por chamada): a mesma pergunta em até **12 h**
  reaproveita o lote (mesmos ids — `?frete=` da sacola e o caderninho da Lia
  continuam válidos) e cada cotação fecha pedido por **24 h**; depois, o
  checkout devolve `SHIPPING_QUOTE_STALE` e recota sozinho, e a Lia é
  instruída a chamar `cotar_frete` de novo. O pedido guarda
  `shipping_service` ("PAC"/"SEDEX") e `shipping_quote_id` (a linha, com a
  resposta bruta em `raw` para conferir a re-pesagem). Falha do provedor
  (timeout de 6 s, HTTP ≠ 2xx, sem token) = lista vazia = o fluxo pela
  equipe de sempre, com `console.warn("[correios] …")` nos logs da Vercel.
  Regras do cache (`pickCachedQuotes`, core): por serviço vale a linha MAIS
  ANTIGA ainda reaproveitável (dois lotes nascidos quase juntos não trocam o
  id da cliente); resposta incompleta (só PAC) volta a perguntar pelo SEDEX
  depois de 1 h; provedor fora do ar entre 12 h e 24 h devolve a última
  cotação ainda válida (a Lia e o checkout fecham com o id que a cliente já
  tinha). O ensaio da Lia cota de verdade mas não grava. Consequências a
  saber: **desativar** uma faixa de motoboy faz os CEPs dela receberem
  PAC/SEDEX (a exclusividade é só de faixa ativa — igual a antes, quando
  ganhavam "frete pela equipe"); uma faixa manual de Correios criada DEPOIS
  de uma cotação não invalida o id já entregue (fecha por até 24 h pelo
  valor visto); duas abas cotando a MESMA chave no mesmo segundo podem
  gerar ids diferentes — o checkout avisa "a opção foi atualizada" e mostra
  a marcada antes de fechar.
  Desligar o toggle desfaz tudo na hora. Caixa padrão 16 × 4 × 24 cm e peso
  mínimo de 300 g (`src/core/shipping/correios-package.ts`); pacote maior é
  custo da loja no balcão, nunca cobrança extra à cliente. Produção: migração
  0045 + `scripts/sync-seed.ts --settings store_cep,correios_auto_enabled,correios_surcharge_cents`.
  A tabela cresce devagar (≈ 2 linhas por CEP × peso a cada 12 h); limpeza
  opcional: `delete from shipping_quotes where expires_at < now() - interval '90 days'`
  (a FK do pedido é `set null`). Pendência conhecida: o selo "peça até" da
  cidade (`getDeliveryHorizonDays`) segue sem horizonte quando não há faixa
  de Correios ativa.

## Embalar antes de sair (foto do pacote obrigatória)

Desde 2026-09-18 (pedido #1016 pulou a etapa): **"Saiu"** (Rota do dia, ficha
e "Montar saída" com GPS) e **"Marcar como enviado"** (Correios) só funcionam
com a **foto do pacote** registrada — "Embalei — enviar foto" na Mesa de
embalagem ou no card Embalagem da ficha (a foto vai à cliente pelo
WhatsApp). O status "Em separação" sozinho não libera ("Iniciar separação" só
muda o status). Sem foto: a Rota mostra "Falta embalar — foto do pacote" no
lugar do botão, o pedido não entra na saída com GPS (a montagem recusa
listando os números), e a ficha mostra o aviso no card Ações. **Dinheiro na
entrega** embala ainda "aguardando pagamento" (a Mesa lista com o badge "Paga
ao receber"; a foto libera o Saiu; o pagamento é marcado quando o motoboy
volta). Pedidos que já tinham saído antes da regra fecham normalmente
("Entregue — o motoboy voltou"). **Entrega em mãos** ("Marcar como entregue"
e "Entregue — enviar foto" na Mesa de entrega): pedido **de motoboy** ainda
na loja também exige a foto do pacote; pedido sem janela (a cliente pegou na
loja) dispensa. A legenda da foto da embalagem usa `{{proximo}}`: motoboy →
"ela sai com o motoboy e a gente te avisa na hora", Correios → "em breve
mandamos o rastreio" (o template antigo em produção é corrigido na hora do
envio; para trocar o texto de vez, `scripts/sync-seed.ts --templates
order_packed --force-templates` ou edite em WhatsApp › Modelos). O Bom dia
conta "a embalar"/"a enviar" com a mesma régua da Mesa. **Na virada**:
pedidos pagos/em separação já postados nos Correios sem foto precisam de
"Marcar como enviado" antes do deploy ou de uma foto tardia depois.
Regra em `src/core/orders/packing.ts`; `dispatchOrder`, `createDeliveryRun`,
`shipOrder`, `deliverByHand` e `deliverOrderWithPhoto` conferem.

## Entrega por motoboy: rota do dia e "Saiu"

**/admin/pedidos/rota** lista os pedidos com janela de entrega (faixa
Motoboy em **/admin/frete**) — pagos e os de **dinheiro na entrega** (que
ficam "aguardando pagamento" até o motoboy voltar) — por horário, com
endereço, telefone e o que receber. **Saiu** marca o pedido pago como
enviado; o de dinheiro só ganha a marca de saída e vai para **Na rua** até
você registrar o pagamento no pedido e clicar **Entregue — o motoboy
voltou**. Nos dois casos a cliente recebe "Saiu da TRIVÉ, chega hoje entre
19h e 21h" (template `order_out_for_delivery`), uma vez só. Janela que já
passou não sai: reagende antes. Pedido que **pagou depois da hora-limite** ou com
janela de ontem aparece marcado com **Reagendar** — a nova janela não avisa a
cliente sozinha: combine pelo link do WhatsApp do card. Template novo em
produção entra com `scripts/sync-seed.ts --templates order_out_for_delivery`.

## Saída do motoboy com GPS

Uma **saída** é um motoboy com um grupo de pedidos. O motoboy recebe um link
no WhatsApp, abre no celular (sem app), toca **Comecei a rota** e a página
compartilha a posição dele enquanto entrega; a cliente acompanha pelo link
do pedido que já recebe e você acompanha em **/admin/pedidos/saidas**.

1. **Cadastre o motoboy** em **/admin/pedidos/motoboys** (nome + WhatsApp).
   Se ele responder ao número da loja, a mensagem vem para você — nunca para
   a Lia.
2. Na **Rota do dia**, marque **Levar nesta saída** nos pedidos, escolha o
   motoboy e **Montar saída**. Cada pedido recebe o "Saiu" de sempre (a
   cliente é avisada na hora; quem já tinha saído não recebe de novo) e o
   motoboy recebe o link. Os endereços são geocodificados pela fila em
   ~1 min (OpenStreetMap, melhor esforço): sem coordenada, a cliente vê o
   motoboy no mapa mas não a distância.
3. Na página da saída: o link (para reenviar ou copiar), a última posição do
   GPS, cada parada com a prova — hora, quem recebeu, ponto do GPS e a
   **foto da entrega** (miniatura) — e os gestos **Encerrar** (só sem parada
   por entregar) e **Cancelar**.
4. O motoboy marca **Entregue** (a câmera abre: a **foto do pacote na mão da
   cliente ou na portaria é obrigatória**, depois pergunta quem recebeu) ou
   **Não consegui** (motivo, sem foto). A foto é reduzida no celular e
   precisa de internet na hora — sem sinal, ele tenta de novo quando voltar
   (o GPS continua guardado). Pedido pago vira entregue e a cliente recebe a
   foto com "entregue às 17:42, recebido por Maria". **Dinheiro na
   entrega** fica aguardando: a prova (com a foto) está na parada, você
   registra o pagamento no pedido e clica **Entregue — o motoboy voltou**,
   como antes — a cliente recebe a foto nessa hora. Se você já tinha tirado
   a foto pela ficha, a do motoboy não a substitui; "Refazer a foto" na
   ficha continua valendo. Se a cliente tocou **Chegou!** na página dela
   antes de o motoboy fechar a parada, ela já recebeu o aviso em texto — a
   foto do motoboy fica na página do pedido e na ficha, sem segunda
   mensagem. **Não consegui** avisa você no WhatsApp; o
   pedido continua como saído — combine com a cliente e reagende.

**Cancelar** uma saída fecha as paradas por entregar e mata o link; o "Saiu"
dos pedidos **não volta** (a máquina não tem "desenviar") — cada um segue
pelo fluxo manual. A trilha do GPS some em 30 dias (cron `delivery-positions-purge`
às 07:00); a posição da entrega fica na parada como prova.

Limites do GPS pelo navegador: no **Android/Chrome** a posição continua
chegando com o Waze aberto por cima; no **iPhone** a página precisa ficar na
frente (suporte de guidão). "Sem sinal há N min" na página da cliente é
esperado quando o celular ficou no bolso; a entrega em si não depende disso.
Depois de um deploy com cron novo: `curl -X PUT https://trivemaison.com.br/api/inngest`.

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

## Lia: sacola robusta (SKU visível, remover pelo nome, quantidade = total)

Incidente de 18/09: a Lia pôs a mesma peça 2×, pôs uma peça errada e não
conseguiu tirá-la (a linha guardava um SKU antigo — a dona renomeou a peça —
e a sacola não mostrava SKU nenhum). Desde então:

- A sacola guarda também o **id da variante**; `ver_sacola` e o caderninho
  mostram cada linha com `[sku: …]` (só a Lia lê; se copiar, o texto some
  antes de chegar à cliente). Regra 13 do prompt: SKU nunca vai para a cliente.
- **`adicionar_a_sacola`: quantidade é o TOTAL da linha**, nunca soma —
  repetir a chamada (o turno do "SIM") não muda nada; para 2 unidades a Lia
  passa `quantidade: 2`.
- **`remover_da_sacola` aceita o SKU ou o nome** como está na sacola
  ("cropped íris marrom"); com o SKU atual de uma linha velha, a variante
  decide; duas linhas parecidas → ela lista com `[sku: …]` e pede a escolha.
- **Linha velha se cura**: `adicionar_a_sacola`, `ver_sacola` e `criar_pedido`
  conferem cada linha no catálogo — linha com id de variante só pela variante
  (SKU reaproveitado por outra peça nunca troca a linha); linha sem id (ponte
  do site, sacola de antes) pelo SKU, e só se o nome bater. Regravam
  SKU/nome/preço atuais e juntam duplicatas da mesma variante; **preço que
  mudou ou linhas juntadas → `criar_pedido` recusa e pede o resumo de novo**
  (a cliente nunca fecha com valor que não viu); peça desativada/apagada é
  marcada "não está mais à venda — tire pelo nome" (`criar_pedido` recusa
  até tirar).
- Busca por SKU é **exata** (`lower(sku) =`), não mais `ILIKE`: `_`/`%` não
  são curingas (um `%` solto devolvia a primeira variante da tabela).

## Lia: o catálogo inteiro em até 3 listas

A lista tocável do WhatsApp aceita **10 linhas**. Desde 2026-09-17, `listar_produtos`
sem `pagina` manda o catálogo **inteiro de uma vez**, em até **3 listas** de 10
("Toque abaixo e veja o catálogo 👇 (11–20 de 25)"), na ordem, antes do texto
da Lia, com o cartão de fotos junto da primeira. Acima de 30 peças vão as 3
primeiras listas e a Lia sugere um filtro (categoria, cor, tamanho, preço) ou
pede as próximas com `pagina: 4` (só numa próxima mensagem da cliente). O
mesmo catálogo pedido de novo em **30 min** manda só a primeira lista: a
guarda lê o que foi **entregue** (`wa_messages` do tipo lista, `sent`, com o
mesmo conteúdo) — lista que falhou na Z-API, copiloto e ensaio não enganam —
e o histórico marca cada lista com a faixa ("[lista tocável do catálogo
(21–25 de 25) enviada ao cliente]", ou "que NÃO chegou à cliente (falhou)"),
então a Lia sabe o que está na conversa. Teto de 3 listas por turno mesmo
com duas buscas (a segunda leva só a primeira lista). Tetos em
`src/core/bot/option-list.ts`.

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
fotos da peça para o número da TRIVÉ e, em seguida, um recado com o nome
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

**/admin/produtos/chegadas** lista cada chegada (fotos, recado, o que foi
entendido, rascunho, fornecedor, conta, cartão, o que deu errado). **Refazer**
(só o dono) arquiva o rascunho antigo (nunca apaga — edição manual fica
arquivada junto), cancela a conta a pagar pendente e põe a montagem de novo na
fila com as mesmas fotos e o mesmo recado; chegada que **já lançou estoque**
não se refaz por aqui (estoque é histórico) — ajuste pelo painel. Fotos sem
recado: **3 minutos** depois da primeira foto do lote a dona recebe "Recebi
2 fotos 📸 Me conta o nome, cores, tamanhos e custo" (template
`owner_atelier_nudge`, evento `wa.atelier_nudge`, só se o recado ainda não
chegou). Produção: `scripts/sync-seed.ts --templates owner_atelier_nudge`.

## Etiquetas das peças (tag de cabide e adesiva)

**Produtos → peça → Etiquetas** (ou, no estoque, o link depois de dar entrada,
já com a quantidade). Dois modelos:

- **Tag de cabide** (padrão): cartão de 55 × 90 mm, marca na frente; nome da
  peça, cor/tamanho, referência, composição e o QR da peça no site atrás —
  sem preço (o QR leva ao preço certo). Sem fundo impresso: o papel é o
  fundo — use cartão creme de 180–300 g.
  - *Impressora comum*: folha A4 com 9 tags, frente e verso. A impressora
    de casa só vira papel comum (64–90 g) sozinha — em cartão o duplex
    automático não existe. Por isso os botões são por lado: **Imprimir
    frentes** (todas as folhas), **virar a pilha inteira de uma vez, como quem
    fecha um livro** (pela lateral — não folha por folha, não de cabeça para
    baixo), recolocar na bandeja de trás com o lado em branco para cima e o
    **topo da folha entrando primeiro** (o rodapé "folha n de N" fica para
    cima, do lado de fora) e **Imprimir versos** com as mesmas opções
    (funciona tanto se a impressora empilha 1→N como N→1). Conferência: os
    rodapés da frente e do verso na mesma folha E na mesma borda — em bordas
    opostas, a pilha entrou girada. Escala 100 %. Primeiro uma folha de
    teste: contra a luz, frente e verso têm de bater. "Frente e verso numa passada" é só para
    teste em papel comum (frente e verso na borda longa). Corte pelas marcas
    dos cantos (régua + estilete) e fure na cruz do topo (furador de 4 a
    6 mm ou ilhós). O verso já vem espelhado — não mexa na ordem. Se a
    impressora não imprimir a linha de baixo (jato de tinta com margem
    inferior grande), fique com 2 linhas por folha ou use o modo Gráfica.
  - *Gráfica*: uma página por lado, 61 × 96 mm (3 mm de sangria + marcas de
    corte), um par frente/verso por variação. Salve como PDF pelo **Chrome**
    (o Safari ignora o tamanho da página) e mande com a lista de quantidades
    que aparece na tela.
  - *Silhouette Portrait* (print & cut): a plotter **só corta** — a folha é
    impressa pela TRIVÉ, na jato de tinta, **já com as marcas de registro**
    (quadrado + dois "L") no padrão do Studio (recuo 15,875 mm em cima,
    esquerda e direita, 26 mm embaixo; "L" de 20 mm, traço 0,5 mm), e a
    plotter lê essas marcas. Cabem **4 tags por folha** (as marcas ocupam as
    margens); a grade é centrada na página, e o verso é a reflexão física
    (x' = 210 − x − 55) — centrar na área útil (assimétrica) deslocava o
    verso 13 mm. Papel: o melhor é fotográfico **fosco dupla face 220 g**
    (verso bom, sem reflexo no sensor); no glossy de uma face o verso vai no
    dorso sem revestimento — imprimir o verso como papel comum. Impressão
    como no modo *Impressora comum* (frentes → virar a pilha → versos). Tipo
    de papel e qualidade ficam no diálogo do SISTEMA: na prévia do Chrome,
    o link "Imprimir usando a caixa de diálogo do sistema…" (não o atalho de
    teclado direto na página — sem o botão saem os dois lados); lá conferir
    A4, 100 %, frente e verso DESMARCADO e, no painel da Epson (Opções da
    Impressora), tipo **Premium Presentation Paper Matte** no fosco (ou
    Photo Paper Glossy no glossy) e qualidade **normal ou alta** (no rascunho
    as marcas saem claras e a plotter não lê); salvar como predefinição
    "TRIVÉ tags". As marcas só saem na frente, e o rodapé "folha n de N ·
    frente/verso" confere se a pilha virou certo. No Studio,
    **uma vez só**: *Preferências* → unidades em mm e importação de DXF "As
    Is" (não "Fit to Page"); abrir o **DXF de corte** (botão na tela — o
    mesmo para toda folha e toda peça); *Page Setup* A4, base Portrait,
    **marcas de registro ligadas** (Tipo 1) → "Restaurar padrões" e conferir
    recuos 15,9 mm (esq./cima/dir.) e 26 mm (embaixo), comprimento 20 mm,
    espessura 0,5 mm (mover as marcas é o que mais causa "não leu");
    selecionar tudo, **conferir 210 × 297 mm** no painel Transformar (o
    retângulo grande é a folha; se vier em outro tamanho, digitar 210 com a
    proporção travada), ponto de referência no canto superior esquerdo,
    X 0 · Y 0, apagar o retângulo grande (camada PAGINA); as 4 molduras têm
    de cair na área sem hachura, as marcas da tela coincidir com as
    impressas e o furo ficar perto do TOPO de cada moldura (embaixo = DXF
    invertido, espelhar na vertical); *Salvar como* "TRIVÉ tags.studio3". **Cada vez**: folha na base com a frente (marcas) para
    cima, o quadrado no canto da seta, cobrindo a linha preta da grade;
    abrir "TRIVÉ tags.studio3" → *Enviar* (Cardstock/Photo Paper, AutoBlade).
    Numa folha com menos de 4 tags a plotter corta o resto em branco — sem
    prejuízo. Primeira vez: teste em papel comum (frente e verso de uma
    folha, contra a luz as tags do verso sobre as da frente, depois corte
    com pressão baixa). "Não leu as marcas": luz forte por cima (não lateral);
    glossy reflete — adesivo branco fosco nos cantos das marcas antes de
    imprimir, ou o fotográfico fosco dupla face; se insistir, *registro
    manual* no Studio. As marcas, as
    posições e o DXF ficam em `src/core/catalog/silhouette.ts`.
- **Adesiva**: Pimaco A4355 (63,5 × 31 mm, 27 por folha), com SKU e preço. O
  fio cinza em volta de cada etiqueta é guia só na tela — não imprime.
- **Adesivo da sacola** (`/admin/produtos/selos?modelo=sacola`): **15 × 10 cm**,
  a marca em destaque (monograma, letreiro, tagline e a frase da vitrine —
  setting `store_tagline`), QR para a Lia no WhatsApp da loja
  (`store_whatsapp`; sem ele o adesivo sai sem QR e sem telefone), WhatsApp,
  Instagram em destaque (setting `store_instagram`, padrão
  `@trive_mfeminine`, editável em Configurações → Dados da loja; aparece
  também no rodapé do site) e o site. **2 por folha A4** é o máximo físico;
  o campo "Folhas" vai até 10 (20 adesivos). Mesmos dois modos do selo: papel comum
  (marcas de corte nos cantos, régua e estilete) ou Silhouette (cantos
  arredondados r 6, kiss cut, arquivo "TRIVÉ sacola.studio3"). Conferir a
  leitura do QR com o celular na primeira folha.
- **Selos de embalagem** (`/admin/produtos/selos`, link na lista de produtos
  e na página de etiquetas): adesivo redondo de **50 mm** com o logotipo e o
  slogan, para fechar o papel que embala a peça. Disco marfim impresso, anel
  duplo dourado, monograma, letreiro e "Maison Féminine". Dois jeitos:
  *papel adesivo A4 comum* (15 por folha; corte pela linha cinza fina com
  tesoura ou furador de círculo de 2" = 50,8 mm, o de scrapbook — o marfim
  sangra 1 mm além da linha; adesivo comum sem revestimento imprime como
  "Papel comum", fotográfico fosco como "Premium Presentation Paper Matte")
  e *Silhouette* (12 por folha; a folha sai com as marcas de registro, como
  as tags; a grade é centrada na ALTURA da folha, então um DXF invertido no
  Y cai no mesmo lugar; no Studio abrir o DXF uma vez, marcas no padrão,
  salvar "TRIVÉ selos.studio3"; material *Papel adesivo*, corte **kiss
  cut** — só o adesivo, a base fica inteira; começar com força baixa).
  Geometria em
  `src/core/print/round-labels.ts`; desenho em
  `src/app/admin/(protected)/produtos/selos/seal.tsx`.
- **Cartões da edição** (`/admin/pedidos/<id>/cartoes`, desde 2026-09-20):
  os JPEGs do cartão (9 × 12) e da carta de estreia (15 × 10) — os mesmos da
  caixa — arrumados em folha **A4 de papel fotográfico** (a L4260 imprime foto
  só de um lado; cartão dobrável foi descartado: o fotográfico quebra na
  dobra). *Tesoura* (`?formato=a4`): **4 cartões por folha** (2 × 2; x 12/108,
  y 25,5/151,5) e, na primeira compra, uma **folha mista** com a carta em cima
  (30, 45,5) e 2 cartões embaixo; corte pela linha marfim do cartão e pelas
  marcas dos cantos; imprimir como "Premium Presentation Paper Matte" (fosco)
  ou "Photo Paper Glossy". *Silhouette* (`?formato=silhouette`): **2 por
  folha** (uma coluna — a área útil tem 165 mm; calha 4; x 66,61, y
  26,5/150,5) e a **carta sozinha** na folha (layout misto não é simétrico na
  altura: DXF invertido cortaria trocado); DXF `cartoes-corte-silhouette.dxf`
  → "TRIVÉ cartões.studio3"; a carta usa **o mesmo corte do adesivo da
  sacola** ("TRIVÉ sacola.studio3", trocando o material ao Enviar: cartolina
  ou photo paper, **corte total**, não kiss cut). Por baixo de cada imagem
  uma base marfim `EDITION_PAPER` (#fdfbf6, a cor exata dos JPEGs) 1 mm
  maior; na Silhouette a imagem recua 0,3 mm num quadro com cantos r 5, para
  a hairline do JPEG não aparecer. Só entra na folha o que já tem imagem
  (peça nova ou carta escrita depois ficam fora até "Gerar de novo"; a tela
  avisa). Geometria e alocação em `src/core/print/edition-sheets.ts`
  (`planEditionSheets`); folha em `pedidos/[id]/cartoes/card-sheet.tsx`. O
  bilhete do presente continua na própria página (`/bilhete`).

Tetos: 200 por variação e 20 folhas por vez. As medidas ficam em
`src/app/admin/(protected)/produtos/[id]/etiquetas/hang-tag.tsx` (tag) e
`label-sheet.tsx` (adesiva); `npx tsx scripts/preview-etiquetas.tsx` gera
uma prévia com PDFs sem precisar do painel.

## Trocar o logo

O site, os ícones, a imagem de compartilhamento (OG), os comprovantes, os
cartões e o Bom dia saem todos de `brand-source/logo.svg`. Com o arquivo novo
do designer em mãos, a troca é um PR de quem programa:

1. Guardar o arquivo entregue, sem mexer, em `brand-source/entregue/` (nome
   com data). Conferir o que veio: monograma em `<path>` (vetor) ou em
   `<image>` (bitmap mascarado — funciona, mas perde nitidez acima de ~600 px);
   letras TRIVÉ e MAISON FÉMININE em `<path>` de fonte.
2. Ajustar `scripts/curate-brand-source.py` para o arquivo novo (hoje ele
   junta as duas entregas: letras do Canva + monograma do vetor) e rodar
   `python3 scripts/curate-brand-source.py` → `brand-source/logo.svg` com os
   grupos `#monograma`, `#wordmark` e `#tagline`.
3. `node scripts/generate-brand-assets.mjs && node scripts/generate-pwa-icons.mjs && node scripts/generate-receipt-assets.mjs`
   e commitar tudo o que mudou (`public/brand/`, `src/app/*.png`,
   `brand-source/generated/`, `assets.ts`, `lettering.generated.ts`,
   `src/receipts/assets.generated.ts`).
4. Conferir: `pnpm test` (tests/lib/brand-assets), a home (véu, hero, rodapé),
   o cabeçalho de /produtos, `npx tsx scripts/preview-card.ts` e, depois do
   deploy, `curl -I https://trivemaison.com.br/opengraph-image.png`. O
   WhatsApp guarda a prévia antiga do link por alguns dias.

O nome escrito no logo é fixo (TRIVÉ). Se a loja for renomeada no painel, o
letreiro some sozinho e volta o nome em texto.

## A Lia passou a conversa com "Assistente de IA indisponível"

O motivo entre parênteses diz o que a API da Anthropic respondeu:

- **limite de uso da API (429)** ou **API da Anthropic instável (5xx)**: passageiro.
  A Lia já tentou 5 vezes (5 s, 10 s, 20 s, 40 s) antes de transferir. Se vira
  rotina, a conta está no nível de uso mais baixo da Anthropic: em
  platform.claude.com → Limites de taxa, o nível sobe com o gasto acumulado
  (ou pedindo à Anthropic).
- **teto de gasto da API atingido (429)** / **limite de gasto configurado na
  conta**: o gasto do mês bateu no teto (da Anthropic ou o que foi definido
  em Limites) — não passa sozinho até o mês virar ou o limite subir.
- **sem crédito na API da Anthropic** / **problema de cobrança**: comprar
  créditos em platform.claude.com → Faturamento (e ligar a recarga
  automática para não repetir).
- **chave da API inválida (401)** / **sem permissão (403)**: a
  `ANTHROPIC_API_KEY` da Vercel foi trocada ou revogada — gerar outra no
  console e atualizar a variável (deploy de novo).
- **modelo não encontrado (404)**: o modelo escolhido em Vendedora & WhatsApp
  não existe nessa conta — voltar para o padrão.

Em qualquer caso, a cliente recebeu "atendimento automático indisponível — já
chamei a equipe". Depois de resolver, **Devolver à Lia** na conversa: se ela
escreveu enquanto isso, a Lia responde na hora. O detalhe técnico (status,
código, tentativa) fica no audit `wa.bot_turn_failed` e nos logs da Vercel
(`[assistant] falha na API da Anthropic`).

- **"erro 400 da API (invalid_request_error): …"** — pedido malformado, é
  bug nosso e a frase da API vem no motivo (painel › faixa da transferência
  e `audit_log` `wa.bot_turn_failed`). Caso real de 19/09/2026: *"This
  model does not support assistant message prefill. The conversation must
  end with a user message"* — a cliente mandou uma mensagem enquanto a Lia
  ainda pensava a resposta anterior; a resposta saiu depois e o turno
  seguinte montou o histórico terminando com a própria Lia. Desde então o
  histórico cola cada resposta à mensagem que ela respondeu (a nova fica por
  último) e um turno sem mensagem nova da cliente não roda o modelo. Depois
  de qualquer transferência por erro, **Devolver à Lia** religa a vendedora
  naquela conversa (o silêncio de 24 h é só dela). A pergunta que recebeu o
  "indisponível" é **sua** para responder (é para isso que a conversa veio
  para você); se a cliente escreveu de novo depois disso, a Lia responde na
  hora ao devolver; se não, ela volta a falar na próxima mensagem dela. Sua
  resposta pelo painel vale para a última mensagem dela que estava na tela
  quando você clicou Enviar: o que chegar depois a Lia ainda trata (ou
  sugere, no copiloto).

## A Lia não respondeu uma cliente (a mensagem nem aparece no painel)

Caso real de 16/09/2026: dois dias sem nenhuma mensagem chegar ao sistema,
com a Z-API "conectada" e o site no ar. Causa: o WhatsApp esconde o número
de alguns contatos (LID) e a Z-API mandava `phone` como `…@lid`; o webhook
descartava em silêncio. Desde então:

- **Toda mensagem que o sistema não consegue processar fica registrada**
  (`inbound_events` com status `ignored` e o motivo) **e chega no seu
  WhatsApp** com o texto da cliente — responda pelo celular da loja.
- **Vigia** (a cada 10 min): compara os chats que o WhatsApp da loja tem
  com o que o sistema registrou. Qualquer chat com mensagem que não chegou
  (ou não-lida que a Lia já teria lido) vira aviso no seu WhatsApp e por
  e-mail, no máximo um por chat por hora. Se foi você digitando no celular
  da loja, ignore o aviso.
- **Rotina que falhou** (fila, resumo diário, e-mail, monitor…): aviso no
  seu WhatsApp e por e-mail com o nome da rotina e o erro, uma vez por
  hora por rotina. O aviso chega uns 5 min depois da primeira falha (o
  Inngest tenta 4 vezes antes).

Recebeu um aviso e quer investigar: painel → **Fila** (`/admin/fila`) mostra
os eventos parados; o painel do Inngest mostra cada rotina. Para conferir
a Z-API por fora (com as chaves de `.env.prod.local`): `GET /status`
(conectada?), `GET /me` (URL do webhook: tem de ser
`trivemaison.com.br/api/webhooks/zapi/<segredo>`), `GET /chats` (última
mensagem por chat — se a Z-API tem e o banco não, o webhook falhou).
Números ocultos aparecem no painel como "número oculto": a Lia responde
normalmente, mas não consegue reservar/fechar pedido sem o telefone — ela
pede à cliente.

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
Depois da limpeza pré-inauguração (abaixo) o saldo é exatamente a soma do
histórico que sobrou (compras, ajustes, perdas).

## Limpeza pré-inauguração (zerar clientes, conversas e pedidos de teste)

Decisão da dona (2026-09-18): antes de abrir a loja, TODAS as conversas do
WhatsApp, TODOS os clientes e TODOS os pedidos de teste (com entregas,
saídas de motoboy, "chegou bem?", reservas, cartelas, fotos e comprovantes)
saem de produção. Ficam: usuários, configurações, modelos de WhatsApp,
catálogo (fotos, preços, custos), fornecedores e suas contas a pagar,
entradas/ajustes/perdas de estoque, faixas de frete (menos a de teste),
cupons (contador zerado), links de story, edições, lançamentos, motoboys
cadastrados e e-mails. Estoque: os movimentos de venda/reserva de teste
somem do livro e o saldo é recalculado só a partir do que sobra (o
histórico continua sendo a verdade). Peças de teste ("teste", DEMO-*,
TESTE-*) são arquivadas, a faixa "Frete grátis (teste de pagamento)" é
apagada e o próximo pedido passa a ser o **#1001**. Tudo do banco numa
única transação — ou tudo ou nada; os gatilhos de proteção são desligados
pelo nome só dentro dela e religados (e conferidos) antes do commit.

### Antes (obrigatório)

1. Backup na hora, pelo computador (o workflow **Backup** do GitHub só
   funciona depois de cadastrar o secret `DATABASE_URL` — em 18/09/2026 ele
   falhava desde 25/08 por falta dele):

       mkdir -p "$HOME/TRIVE-backups" && pg_dump "$(grep '^DATABASE_URL=' .env.prod.local | cut -d= -f2-)" --no-owner --format=custom --file="$HOME/TRIVE-backups/trive-pre-limpeza-$(date +%F).dump"

   Conferir com `pg_restore --list "$HOME"/TRIVE-backups/trive-pre-limpeza-*.dump | head`.
   O `pg_dump` tem de ser da versão do servidor ou mais nova
   (`/opt/homebrew/opt/postgresql@17/bin/pg_dump`).
2. Fila vazia: **/admin/fila** sem evento "processando" (o script recusa
   se houver, antes e dentro da transação). Se um webhook ou um turno da
   Lia estiver no meio de uma escrita, o banco pode responder "deadlock"
   ou "trava ocupada": a transação desfaz tudo e o script tenta de novo
   sozinho (2 vezes, 15 s de intervalo) — depois disso, rodar de novo.
3. Se houver testes de mão a fazer (catálogo, sacola, embalar → Saiu, GPS),
   fazer ANTES; se fizer depois, rode a limpeza de novo antes de abrir.

### Simulação (não grava nada)

    npx tsx --env-file=.env.prod.local scripts/limpar-para-inauguracao.ts

Conferir na saída: o host do banco, cada conversa e cliente listados (para
confirmar que é tudo teste — telefones mascarados), as contagens, o estoque
"antes → depois" por SKU e os ajustes manuais (se algum ajuste foi feito
para "consertar" uma baixa de teste, o saldo recalculado fica errado —
corrigir com novo ajuste depois), as peças a arquivar (as variantes delas são desativadas, para sumirem
também do controle de estoque), a faixa de frete e as compras de
fornecedor (ficam; de teste, apagar no painel). Se aparecer "AVISO: o
--apply vai RECUSAR", há um movimento de reserva sem pedido ou um saldo
que ficaria negativo — corrigir no histórico antes.

### Aplicar

    npx tsx --env-file=.env.prod.local scripts/limpar-para-inauguracao.ts --apply --confirmo=LIMPAR-PRODUCAO

Antes de abrir a transação o script exporta em JSON as linhas que vão sumir
(pasta temporária, o caminho sai no log). Depois do commit apaga os arquivos
do bucket (`receipts/ packages/ deliveries/ gifts/ editions/ looks/ atelier/`,
inclusive órfãos); se algum falhar, lista os caminhos e sai com código 3 —
apagar à mão no Supabase Storage. `--sem-storage` limpa só o banco.
Códigos: 0 ok · 1 erro (nada gravado) · 2 recusado (confirmação, fila,
ADAPTER_MODE) · 3 banco ok, mas ou ficou arquivo por apagar (lista na tela)
ou a varredura de órfãos do bucket não foi possível (conferir os prefixos
no Supabase Storage). A peça de teste arquivada também sai do lançamento,
das edições e dos links de story.

### Depois

- Loja: home e uma peça (as de teste somem em até 5 min — a fila pede a
  revalidação na hora).
- Painel: /admin (vazio), /admin/pedidos, /admin/whatsapp/conversas,
  /admin/estoque (saldos = entradas + ajustes), /admin/financeiro (só
  fornecedor), /admin/fila.
- Notificações antigas do Mercado Pago sobre pagamentos de teste podem cair
  em /admin/fila como "pedido não encontrado" — **Descartar**.
- O vigia do WhatsApp foi silenciado para os chats com movimento nas últimas
  6 h; se um aviso "mensagem que não chegou" aparecer mesmo assim, é falso
  (o registro foi apagado de propósito).
- No celular que fez o quiz de estilo, abrir /estilo uma vez (a home pode
  ficar em "Escolhendo as peças…" com a cartela antiga).
- NÃO fazer pedido de teste depois: o próximo número é o #1001 da primeira
  cliente. A limpeza fica registrada em `audit_log`
  (`maintenance.launch_reset`) com todas as contagens.

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
