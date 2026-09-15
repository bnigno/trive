CREATE TABLE "couriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "couriers_phone_e164_unique" UNIQUE("phone_e164"),
	CONSTRAINT "couriers_name_check" CHECK (char_length("couriers"."name") BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "delivery_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy_m" real,
	"speed_mps" real,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"courier_id" uuid NOT NULL,
	"courier_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_accuracy_m" real,
	"last_position_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_runs_courier_token_unique" UNIQUE("courier_token"),
	CONSTRAINT "delivery_runs_status_check" CHECK ("delivery_runs"."status" IN ('ready', 'en_route', 'finished', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "delivery_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"dest_address" text,
	"dest_lat" double precision,
	"dest_lng" double precision,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"received_by" text,
	"delivered_lat" double precision,
	"delivered_lng" double precision,
	"delivered_accuracy_m" real,
	"failure_reason" text,
	"failure_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_stops_status_check" CHECK ("delivery_stops"."status" IN ('pending', 'delivered', 'failed', 'canceled')),
	CONSTRAINT "delivery_stops_received_by_check" CHECK ("delivery_stops"."received_by" IS NULL OR char_length("delivery_stops"."received_by") <= 60),
	CONSTRAINT "delivery_stops_failure_reason_check" CHECK ("delivery_stops"."failure_reason" IS NULL OR "delivery_stops"."failure_reason" IN ('ninguem_em_casa', 'endereco_nao_encontrado', 'cliente_pediu_outro_dia', 'outro')),
	CONSTRAINT "delivery_stops_failure_note_check" CHECK ("delivery_stops"."failure_note" IS NULL OR char_length("delivery_stops"."failure_note") <= 200)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_delivery_confirmed_by_check";--> statement-breakpoint
ALTER TABLE "delivery_positions" ADD CONSTRAINT "delivery_positions_run_id_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."delivery_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_courier_id_couriers_id_fk" FOREIGN KEY ("courier_id") REFERENCES "public"."couriers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_run_id_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."delivery_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_stops" ADD CONSTRAINT "delivery_stops_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_positions_run_recorded_idx" ON "delivery_positions" USING btree ("run_id","recorded_at");--> statement-breakpoint
CREATE INDEX "delivery_runs_open_courier_idx" ON "delivery_runs" USING btree ("courier_id") WHERE "delivery_runs"."status" IN ('ready', 'en_route');--> statement-breakpoint
CREATE INDEX "delivery_runs_created_at_idx" ON "delivery_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_stops_open_order_idx" ON "delivery_stops" USING btree ("order_id") WHERE "delivery_stops"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_stops_run_sequence_idx" ON "delivery_stops" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "delivery_stops_order_idx" ON "delivery_stops" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_confirmed_by_check" CHECK ("orders"."delivery_confirmed_by" IS NULL OR "orders"."delivery_confirmed_by" IN ('owner', 'customer', 'lia', 'courier'));