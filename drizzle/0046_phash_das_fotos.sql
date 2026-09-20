ALTER TABLE "product_images" ADD COLUMN "phash" text;--> statement-breakpoint
CREATE INDEX "product_images_phash_idx" ON "product_images" USING btree ("phash");