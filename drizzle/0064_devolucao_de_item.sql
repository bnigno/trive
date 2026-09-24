-- Uma peça volta sem o pedido inteiro cair.
--
-- Até aqui só existia o extremo: reembolsar o pedido todo (status 'refunded',
-- terminal, valor total). Quem devolvia UM item entre quatro não tinha onde
-- registrar — nem o valor, nem a peça, nem o desfecho. O pedido segue
-- 'delivered': ele não foi reembolsado, uma peça voltou.
--
-- resolution é o desfecho combinado com a cliente:
--   credito  — vira cupom pessoal de valor fixo (a "troca" na prática)
--   dinheiro — estorno PARCIAL no Mercado Pago
--
-- refund_cents é o que ela pagou PELO ITEM, já descontada a parte do cupom
-- que coube a ele — não o preço de etiqueta. Frete não entra: a política só
-- devolve frete no arrependimento integral.
CREATE TABLE "order_item_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"refund_cents" bigint NOT NULL,
	"resolution" text NOT NULL,
	"state" text NOT NULL DEFAULT 'pendente',
	"mp_refund_id" text,
	"coupon_id" uuid,
	"reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_returns_quantity_check" CHECK ("quantity" > 0),
	CONSTRAINT "order_item_returns_refund_cents_check" CHECK ("refund_cents" >= 0),
	CONSTRAINT "order_item_returns_resolution_check" CHECK ("resolution" IN ('credito', 'dinheiro')),
	CONSTRAINT "order_item_returns_state_check" CHECK ("state" IN ('pendente', 'concluida', 'falhou'))
);--> statement-breakpoint
ALTER TABLE "order_item_returns" ADD CONSTRAINT "order_item_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_returns" ADD CONSTRAINT "order_item_returns_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_returns" ADD CONSTRAINT "order_item_returns_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_returns" ADD CONSTRAINT "order_item_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_returns_order_id_idx" ON "order_item_returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_item_returns_order_item_id_idx" ON "order_item_returns" USING btree ("order_item_id");--> statement-breakpoint

-- Tabela nova nasce legível e apagável pela chave anônima do Supabase se
-- ninguém ligar o RLS (ver migração 0058). tests/db/rls.test.ts guarda isto.
ALTER TABLE "order_item_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Origem nova: o crédito da troca é um cupom pessoal como os outros.
ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "coupons_origin_check";--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_origin_check" CHECK ("origin" IN ('manual', 'late_delivery', 'price_protection', 'look_photo', 'paper_voucher', 'lia_gift', 'referral', 'referral_reward', 'provador_welcome', 'troca'));
