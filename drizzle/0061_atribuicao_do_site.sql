-- O pedido feito no checkout do site passa a guardar de onde a cliente veio:
-- o último link de story (/ig/) ou de cupom (/c/) tocado no navegador, até 7
-- dias antes (core/store/attribution). O pedido da Lia já era atribuído pela
-- ponte (site_carts.order_id); o do site ficava invisível em "De onde vieram".
-- Aditiva: pedidos antigos ficam com NULL (sem origem conhecida).
ALTER TABLE "orders" ADD COLUMN "attribution" jsonb;
