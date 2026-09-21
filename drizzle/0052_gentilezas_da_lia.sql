ALTER TABLE "coupons" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_conversation_id_wa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."wa_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupons_origin_created_at_idx" ON "coupons" USING btree ("origin","created_at");--> statement-breakpoint
CREATE INDEX "coupons_customer_origin_idx" ON "coupons" USING btree ("customer_id","origin");