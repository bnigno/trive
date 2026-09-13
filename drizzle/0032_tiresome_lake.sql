CREATE TABLE "city_edition_products" (
	"city_edition_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "city_edition_products_city_edition_id_product_id_pk" PRIMARY KEY("city_edition_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "city_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"opening_line" text,
	"body" text,
	"districts" text,
	"cover_path" text,
	"starts_on" date,
	"ends_on" date,
	"hour_start" integer,
	"hour_end" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_editions_slug_unique" UNIQUE("slug"),
	CONSTRAINT "city_editions_hours_check" CHECK (("city_editions"."hour_start" IS NULL AND "city_editions"."hour_end" IS NULL) OR ("city_editions"."hour_start" BETWEEN 0 AND 23 AND "city_editions"."hour_end" BETWEEN 1 AND 24 AND "city_editions"."hour_start" < "city_editions"."hour_end")),
	CONSTRAINT "city_editions_period_check" CHECK ("city_editions"."starts_on" IS NULL OR "city_editions"."ends_on" IS NULL OR "city_editions"."starts_on" <= "city_editions"."ends_on")
);
--> statement-breakpoint
ALTER TABLE "drops" ADD COLUMN "city_edition_id" uuid;--> statement-breakpoint
ALTER TABLE "city_edition_products" ADD CONSTRAINT "city_edition_products_city_edition_id_city_editions_id_fk" FOREIGN KEY ("city_edition_id") REFERENCES "public"."city_editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_edition_products" ADD CONSTRAINT "city_edition_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "city_edition_products_product_idx" ON "city_edition_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "city_editions_active_idx" ON "city_editions" USING btree ("is_active","sort_order");--> statement-breakpoint
ALTER TABLE "drops" ADD CONSTRAINT "drops_city_edition_id_city_editions_id_fk" FOREIGN KEY ("city_edition_id") REFERENCES "public"."city_editions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drops_city_edition_idx" ON "drops" USING btree ("city_edition_id");