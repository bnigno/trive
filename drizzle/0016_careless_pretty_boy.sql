CREATE TABLE "bot_cards" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"product_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"render_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
