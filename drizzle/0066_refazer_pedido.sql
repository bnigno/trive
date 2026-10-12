-- "Refazer pedido": a cliente quer mudar um pedido ainda não pago (tirar o
-- cupom, pagar em dinheiro, trocar o tamanho, mudar o bilhete ou a entrega).
-- O antigo é cancelado e um NOVO (número novo) o substitui na mesma
-- transação; replaced_by_order_id aponta para ele. Aditiva: nenhum pedido
-- existente muda. orders já tem RLS (0058).
ALTER TABLE "orders" ADD COLUMN "replaced_by_order_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_replaced_by_order_id_orders_id_fk" FOREIGN KEY ("replaced_by_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_replaced_by_order_id_unique_idx" ON "orders" USING btree ("replaced_by_order_id") WHERE "orders"."replaced_by_order_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_replaced_by_check" CHECK ("orders"."replaced_by_order_id" IS NULL OR ("orders"."status" = 'canceled' AND "orders"."replaced_by_order_id" <> "orders"."id"));