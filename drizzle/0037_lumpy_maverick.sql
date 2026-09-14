ALTER TABLE "orders" ADD COLUMN "delivered_photo_path" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "received_by" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_received_by_check" CHECK ("orders"."received_by" IS NULL OR char_length("orders"."received_by") <= 60);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_confirmed_by_check" CHECK ("orders"."delivery_confirmed_by" IS NULL OR "orders"."delivery_confirmed_by" IN ('owner', 'customer', 'lia'));