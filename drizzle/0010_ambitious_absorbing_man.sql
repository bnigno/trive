CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" text,
	"phone_e164" text,
	"document_type" text,
	"document_number" text,
	"pix_key" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "suppliers_phone_e164_check" CHECK ("suppliers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "suppliers_document_type_check" CHECK ("suppliers"."document_type" IN ('cpf', 'cnpj'))
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_method_check";--> statement-breakpoint
ALTER TABLE "payment_fee_rules" DROP CONSTRAINT "payment_fee_rules_payment_method_check";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_email_unique_idx" ON "suppliers" USING btree ("email") WHERE "suppliers"."email" IS NOT NULL AND "suppliers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_phone_e164_unique_idx" ON "suppliers" USING btree ("phone_e164") WHERE "suppliers"."phone_e164" IS NOT NULL AND "suppliers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_document_number_unique_idx" ON "suppliers" USING btree ("document_number") WHERE "suppliers"."document_number" IS NOT NULL AND "suppliers"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_entries" ADD CONSTRAINT "financial_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_supplier_id_idx" ON "products" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "financial_entries_supplier_id_idx" ON "financial_entries" USING btree ("supplier_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_method_check" CHECK ("orders"."payment_method" IN ('pix', 'credit_card', 'boleto', 'pix_manual', 'cash'));--> statement-breakpoint
ALTER TABLE "payment_fee_rules" ADD CONSTRAINT "payment_fee_rules_payment_method_check" CHECK ("payment_fee_rules"."payment_method" IN ('pix', 'credit_card', 'boleto', 'pix_manual', 'cash'));--> statement-breakpoint
-- SQL manual (drizzle-kit não gera trigger): função set_updated_at existe desde a 0002.
CREATE TRIGGER suppliers_set_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();