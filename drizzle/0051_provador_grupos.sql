CREATE TABLE "wa_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"lid" text,
	"customer_id" uuid,
	"is_admin" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'sync' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_group_members_source_check" CHECK ("wa_group_members"."source" IN ('lia', 'link', 'sync')),
	CONSTRAINT "wa_group_members_left_reason_check" CHECK ("wa_group_members"."left_reason" IS NULL OR "wa_group_members"."left_reason" IN ('saiu', 'removida', 'so_privado'))
);
--> statement-breakpoint
CREATE TABLE "wa_group_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"body" text NOT NULL,
	"image_url" text,
	"poll_options" jsonb,
	"poll_max_options" smallint,
	"poll_closed_at" timestamp with time zone,
	"poll_result" jsonb,
	"product_ids" jsonb,
	"look_ids" jsonb,
	"drop_id" uuid,
	"campaign_link_id" uuid,
	"provider_message_id" text,
	"dedupe_key" text NOT NULL,
	"skipped_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_group_posts_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "wa_group_posts_kind_check" CHECK ("wa_group_posts"."kind" IN ('chegadas', 'enquete', 'quem_vestiu', 'cortina', 'livre')),
	CONSTRAINT "wa_group_posts_status_check" CHECK ("wa_group_posts"."status" IN ('draft', 'scheduled', 'sent', 'skipped', 'canceled')),
	CONSTRAINT "wa_group_posts_poll_max_check" CHECK ("wa_group_posts"."poll_max_options" IS NULL OR "wa_group_posts"."poll_max_options" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "wa_group_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"post_id" uuid,
	"participant_phone" text NOT NULL,
	"customer_id" uuid,
	"kind" text NOT NULL,
	"value" text DEFAULT '' NOT NULL,
	"provider_message_id" text NOT NULL,
	"referenced_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_group_signals_kind_check" CHECK ("wa_group_signals"."kind" IN ('poll_vote', 'reaction', 'mention', 'message'))
);
--> statement-breakpoint
CREATE TABLE "wa_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_group_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'provador' NOT NULL,
	"city_edition_id" uuid,
	"invitation_link" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"paused_until" timestamp with time zone,
	"paused_reason" text,
	"member_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wa_groups_provider_group_id_unique" UNIQUE("provider_group_id"),
	CONSTRAINT "wa_groups_kind_check" CHECK ("wa_groups"."kind" IN ('provador', 'turma')),
	CONSTRAINT "wa_groups_member_count_check" CHECK ("wa_groups"."member_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "wa_group_members" ADD CONSTRAINT "wa_group_members_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_members" ADD CONSTRAINT "wa_group_members_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_posts" ADD CONSTRAINT "wa_group_posts_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_posts" ADD CONSTRAINT "wa_group_posts_drop_id_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."drops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_posts" ADD CONSTRAINT "wa_group_posts_campaign_link_id_campaign_links_id_fk" FOREIGN KEY ("campaign_link_id") REFERENCES "public"."campaign_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_posts" ADD CONSTRAINT "wa_group_posts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_signals" ADD CONSTRAINT "wa_group_signals_group_id_wa_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."wa_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_signals" ADD CONSTRAINT "wa_group_signals_post_id_wa_group_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."wa_group_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_group_signals" ADD CONSTRAINT "wa_group_signals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_city_edition_id_city_editions_id_fk" FOREIGN KEY ("city_edition_id") REFERENCES "public"."city_editions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_groups" ADD CONSTRAINT "wa_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_group_members_group_phone_idx" ON "wa_group_members" USING btree ("group_id","phone_e164");--> statement-breakpoint
CREATE INDEX "wa_group_members_phone_idx" ON "wa_group_members" USING btree ("phone_e164");--> statement-breakpoint
CREATE INDEX "wa_group_members_customer_idx" ON "wa_group_members" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "wa_group_posts_group_status_idx" ON "wa_group_posts" USING btree ("group_id","status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_group_posts_provider_message_idx" ON "wa_group_posts" USING btree ("provider_message_id") WHERE "wa_group_posts"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_group_signals_vote_idx" ON "wa_group_signals" USING btree ("referenced_message_id","participant_phone","kind") WHERE "wa_group_signals"."kind" IN ('poll_vote', 'reaction');--> statement-breakpoint
CREATE UNIQUE INDEX "wa_group_signals_event_idx" ON "wa_group_signals" USING btree ("provider_message_id","kind") WHERE "wa_group_signals"."kind" IN ('mention', 'message');--> statement-breakpoint
CREATE INDEX "wa_group_signals_group_kind_idx" ON "wa_group_signals" USING btree ("group_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "wa_group_signals_post_idx" ON "wa_group_signals" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "wa_group_signals_participant_idx" ON "wa_group_signals" USING btree ("participant_phone");--> statement-breakpoint
CREATE INDEX "wa_groups_active_idx" ON "wa_groups" USING btree ("is_active");