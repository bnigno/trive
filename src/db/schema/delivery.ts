// Saída do motoboy com GPS: o motoboy (cadastro), a saída (vários pedidos,
// um link só, a última posição), cada parada (o pedido, a prova da entrega)
// e a trilha de posições (apagada depois de 30 dias — a última posição fica
// na saída). Nada aqui muda o status do pedido: isso continua passando pela
// máquina de estados; a parada guarda só a prova (hora, quem recebeu, GPS).
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./governance";
import { orders } from "./orders";

export const couriers = pgTable(
  "couriers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** E.164 (+55…): o link da saída vai por WhatsApp para cá. */
    phoneE164: text("phone_e164").notNull().unique(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("couriers_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 60`)],
);

export const deliveryRuns = pgTable(
  "delivery_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courierId: uuid("courier_id")
      .notNull()
      .references(() => couriers.id, { onDelete: "restrict" }),
    /** O link do motoboy (/entrega/<token>): só ele conhece; morre com a saída. */
    courierToken: uuid("courier_token").notNull().unique().defaultRandom(),
    /** ready | en_route | finished | canceled */
    status: text("status").notNull().default("ready"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    lastLat: doublePrecision("last_lat"),
    lastLng: doublePrecision("last_lng"),
    lastAccuracyM: real("last_accuracy_m"),
    lastPositionAt: timestamp("last_position_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("delivery_runs_open_courier_idx")
      .on(table.courierId)
      .where(sql`${table.status} IN ('ready', 'en_route')`),
    index("delivery_runs_created_at_idx").on(table.createdAt),
    check("delivery_runs_status_check", sql`${table.status} IN ('ready', 'en_route', 'finished', 'canceled')`),
  ],
);

export const deliveryStops = pgTable(
  "delivery_stops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => deliveryRuns.id, { onDelete: "restrict" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    /** Ordem das paradas na saída (1, 2, 3…). */
    sequence: integer("sequence").notNull(),
    /** "Av. Nazaré, 100, apto 12 — Nazaré, Belém": o que vai para o Waze. */
    destAddress: text("dest_address"),
    /** Geocodificação best-effort pela fila; null = sem pino nem distância. */
    destLat: doublePrecision("dest_lat"),
    destLng: doublePrecision("dest_lng"),
    /** pending | delivered | failed | canceled */
    status: text("status").notNull().default("pending"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    receivedBy: text("received_by"),
    deliveredLat: doublePrecision("delivered_lat"),
    deliveredLng: doublePrecision("delivered_lng"),
    deliveredAccuracyM: real("delivered_accuracy_m"),
    /** ninguem_em_casa | endereco_nao_encontrado | cliente_pediu_outro_dia | outro */
    failureReason: text("failure_reason"),
    /** Só para o painel — a cliente nunca lê. */
    failureNote: text("failure_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Um pedido em uma saída aberta por vez.
    uniqueIndex("delivery_stops_open_order_idx")
      .on(table.orderId)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("delivery_stops_run_sequence_idx").on(table.runId, table.sequence),
    index("delivery_stops_order_idx").on(table.orderId),
    check("delivery_stops_status_check", sql`${table.status} IN ('pending', 'delivered', 'failed', 'canceled')`),
    check("delivery_stops_received_by_check", sql`${table.receivedBy} IS NULL OR char_length(${table.receivedBy}) <= 60`),
    check(
      "delivery_stops_failure_reason_check",
      sql`${table.failureReason} IS NULL OR ${table.failureReason} IN ('ninguem_em_casa', 'endereco_nao_encontrado', 'cliente_pediu_outro_dia', 'outro')`,
    ),
    check("delivery_stops_failure_note_check", sql`${table.failureNote} IS NULL OR char_length(${table.failureNote}) <= 200`),
  ],
);

export const deliveryPositions = pgTable(
  "delivery_positions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => deliveryRuns.id, { onDelete: "restrict" }),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    accuracyM: real("accuracy_m"),
    speedMps: real("speed_mps"),
    /** A hora do GPS no celular (não a de chegada ao servidor). */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("delivery_positions_run_recorded_idx").on(table.runId, table.recordedAt)],
);
