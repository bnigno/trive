-- Por que o pagamento não passou. O Mercado Pago devolve o motivo em
-- status_detail (cc_rejected_high_risk, cc_rejected_bad_filled_security_code…)
-- e a gente descartava antes de gravar: em 09-10/2026 sete cartões foram
-- recusados pelo site e o dono só soube pela cliente reclamando.
-- Coluna nova, anulável: não apaga nem altera nada.

ALTER TABLE "orders" ADD COLUMN "mp_status_detail" text;