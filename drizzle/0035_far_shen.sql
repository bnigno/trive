ALTER TABLE "atelier_intakes" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD COLUMN "financial_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD COLUMN "card_path" text;--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD CONSTRAINT "atelier_intakes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atelier_intakes" ADD CONSTRAINT "atelier_intakes_financial_entry_id_financial_entries_id_fk" FOREIGN KEY ("financial_entry_id") REFERENCES "public"."financial_entries"("id") ON DELETE restrict ON UPDATE no action;