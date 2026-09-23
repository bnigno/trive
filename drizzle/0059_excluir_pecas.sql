-- Numerada 0059, não 0058: a 0058_rls_e_privilegios nasceu da mesma 0057 em
-- outra branch e já estava aplicada em produção quando esta nasceu. O `when`
-- desta é posterior ao daquela, então a ordem de aplicação fica certa.
--
-- Não cria tabela: só troca UNIQUE de coluna por índice parcial. Por isso não
-- há RLS a declarar aqui (regra da 0058: tabela nova exige RLS na mesma
-- migração, senão o banco reabre sozinho).
--
-- Excluir peças: o endereço (slug) e o código (SKU) passam a ser únicos só
-- entre as peças VIVAS. Sem isto, excluir uma peça cadastrada errado prenderia
-- o slug e o SKU numa linha invisível, e recadastrar daria "já existe" — que é
-- exatamente o caso que motivou a exclusão.
--
-- Não apaga dado nenhum: troca UNIQUE de coluna por índice UNIQUE parcial.
-- O service (assertSkuAvailable) já ignorava variação excluída; agora o banco
-- concorda com ele. Código já vendido continua barrado lá, de propósito.

ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_sku_unique";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_slug_unique";--> statement-breakpoint
DROP INDEX "product_variants_sku_lower_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_unique_idx" ON "products" USING btree ("slug") WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_sku_lower_unique_idx" ON "product_variants" USING btree (lower("sku")) WHERE "product_variants"."deleted_at" is null;