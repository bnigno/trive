import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FileStorage, UploadInput } from "./index";

export const PRODUCT_IMAGES_BUCKET = "product-images";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export class SupabaseFileStorage implements FileStorage {
  private readonly client: SupabaseClient;

  constructor() {
    this.client = createClient(
      requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  async upload(input: UploadInput): Promise<{ path: string }> {
    const body = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(input.data);
    const { error } = await this.client.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .upload(input.path, body, { contentType: input.contentType, upsert: true });
    if (error) {
      throw new Error(
        `Falha ao enviar arquivo ao storage (${input.path}): ${error.message}`,
      );
    }
    return { path: input.path };
  }

  publicUrl(path: string): string {
    return this.client.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path)
      .data.publicUrl;
  }

  async remove(path: string): Promise<void> {
    const { error } = await this.client.storage
      .from(PRODUCT_IMAGES_BUCKET)
      .remove([path]);
    if (error) {
      throw new Error(
        `Falha ao remover arquivo do storage (${path}): ${error.message}`,
      );
    }
  }
}
