ALTER TABLE "orders" ADD COLUMN "needed_by" date;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "occasion" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ship_by" date;--> statement-breakpoint
CREATE INDEX "orders_ship_by_idx" ON "orders" USING btree ("ship_by") WHERE "orders"."ship_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_occasion_length_check" CHECK ("orders"."occasion" IS NULL OR char_length("orders"."occasion") <= 60);--> statement-breakpoint
-- Dados: o presente com data desejada vira data marcada (aditivo: só preenche o que está vazio).
UPDATE "orders" SET "needed_by" = "gift_deliver_by" WHERE "needed_by" IS NULL AND "gift_deliver_by" IS NOT NULL;--> statement-breakpoint
-- Presente com data pedido por motoboy: o dia-limite para sair é o dia da janela (os demais não têm ship_by).
UPDATE "orders" SET "ship_by" = ("delivery_window"->>'dayKey')::date WHERE "ship_by" IS NULL AND "needed_by" IS NOT NULL AND "delivery_window" IS NOT NULL;--> statement-breakpoint
-- Presente com data pelos Correios (pedido antigo, sem a faixa gravada): o limite passa a ser o próprio dia marcado.
UPDATE "orders" SET "ship_by" = "needed_by" WHERE "ship_by" IS NULL AND "needed_by" IS NOT NULL;
