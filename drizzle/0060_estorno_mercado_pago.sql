-- O botão "Reembolsar" passa a devolver o dinheiro de verdade, e isso precisa
-- deixar rastro. Até aqui o pedido virava 'refunded' sem NENHUM registro de
-- que o valor tinha voltado — nem a data (timestampFieldFor não cobre
-- 'refunded'), nem o id do estorno no vendor. Descobriu-se na prática: o
-- pedido #1004 ficou 'refunded' com R$ 54,99 ainda parados no Mercado Pago.
--
-- refund_state é o que o sistema sabe sobre o DINHEIRO, não sobre o pedido:
--   nao_aplicavel — Pix manual ou dinheiro: quem devolve é o dono, por fora
--   pendente      — pedido ao vendor enfileirado, ainda sem resposta
--   devolvido     — o vendor confirmou; refunded_at e mp_refund_id preenchidos
--   falhou        — o vendor recusou até o fim das tentativas; exige a mão do dono
ALTER TABLE "orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "mp_refund_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_state" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_state_check" CHECK ("refund_state" IS NULL OR "refund_state" IN ('nao_aplicavel', 'pendente', 'devolvido', 'falhou'));
