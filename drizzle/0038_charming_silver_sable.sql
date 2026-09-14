CREATE TABLE "delivery_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"phone_e164" text NOT NULL,
	"product_variant_id" uuid,
	"answer" text,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answer_wa_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_feedback_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "delivery_feedback_answer_check" CHECK ("delivery_feedback"."answer" IS NULL OR "delivery_feedback"."answer" IN ('amei', 'grande', 'pequeno', 'defeito', 'falar'))
);
--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_feedback" ADD CONSTRAINT "delivery_feedback_answer_wa_message_id_wa_messages_id_fk" FOREIGN KEY ("answer_wa_message_id") REFERENCES "public"."wa_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_feedback_variant_answer_idx" ON "delivery_feedback" USING btree ("product_variant_id","answer");--> statement-breakpoint
CREATE INDEX "delivery_feedback_phone_idx" ON "delivery_feedback" USING btree ("phone_e164");