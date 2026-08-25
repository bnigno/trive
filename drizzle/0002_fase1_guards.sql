-- Custom SQL migration file, put your code below! --

-- 1) updated_at automático nas tabelas mutáveis da Fase 1.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER categories_set_updated_at
  BEFORE UPDATE ON "categories"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON "products"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER product_variants_set_updated_at
  BEFORE UPDATE ON "product_variants"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER pricing_policies_set_updated_at
  BEFORE UPDATE ON "pricing_policies"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER financial_entries_set_updated_at
  BEFORE UPDATE ON "financial_entries"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER stock_levels_set_updated_at
  BEFORE UPDATE ON "stock_levels"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint

-- 2) Imutabilidade: aborta a operação proibida com erro explícito.
CREATE OR REPLACE FUNCTION forbid_row_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% em % não é permitido (tabela protegida/append-only)',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$;--> statement-breakpoint

-- Append-only total: nem UPDATE nem DELETE.
CREATE TRIGGER stock_movements_forbid_mutation
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint
CREATE TRIGGER variant_costs_forbid_mutation
  BEFORE UPDATE OR DELETE ON "variant_costs"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint

-- Histórico preservado: UPDATE permitido (workflows), DELETE proibido.
CREATE TRIGGER price_versions_forbid_delete
  BEFORE DELETE ON "price_versions"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint
CREATE TRIGGER orders_forbid_delete
  BEFORE DELETE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint
CREATE TRIGGER order_items_forbid_delete
  BEFORE DELETE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint
CREATE TRIGGER financial_entries_forbid_delete
  BEFORE DELETE ON "financial_entries"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint
CREATE TRIGGER order_status_history_forbid_delete
  BEFORE DELETE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_row_mutation();--> statement-breakpoint

-- 3) Números de pedido legíveis começam em #1000.
ALTER SEQUENCE "orders_order_number_seq" RESTART WITH 1000;
