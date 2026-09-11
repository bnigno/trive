import { getAdapterMode } from "../adapter-mode";
import { SupabaseFileStorage } from "./supabase";
import { FakeFileStorage } from "./fake";

export type UploadInput = {
  path: string;
  data: Uint8Array | Buffer;
  contentType: string;
};

export interface FileStorage {
  upload(input: UploadInput): Promise<{ path: string }>;
  publicUrl(path: string): string;
  remove(path: string): Promise<void>;
  /** Lê um arquivo do bucket (ex.: foto de produto para compor uma imagem). Lança se não existir. */
  download(path: string): Promise<{ data: Buffer; contentType: string | null }>;
}

let instance: FileStorage | undefined;

export function getFileStorage(): FileStorage {
  if (!instance) {
    instance =
      getAdapterMode() === "real"
        ? new SupabaseFileStorage()
        : new FakeFileStorage();
  }
  return instance;
}
