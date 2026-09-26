import type { FileStorage, UploadInput } from "./index";

export class FakeFileStorage implements FileStorage {
  private readonly files = new Map<
    string,
    { data: Uint8Array; contentType: string }
  >();

  /** Tipos que o storage "recusa" (simula o bucket real, que só aceita imagem). */
  readonly rejectedContentTypes = new Set<string>();

  async upload(input: UploadInput): Promise<{ path: string }> {
    if (this.rejectedContentTypes.has(input.contentType)) {
      throw new Error(`Falha ao enviar arquivo ao storage (${input.path}): mime type ${input.contentType} is not supported`);
    }
    this.files.set(input.path, {
      data: new Uint8Array(input.data),
      contentType: input.contentType,
    });
    return { path: input.path };
  }

  publicUrl(path: string, options?: { download?: string }): string {
    return `memory://${path}${options?.download ? `?download=${encodeURIComponent(options.download)}` : ""}`;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async download(path: string): Promise<{ data: Buffer; contentType: string | null }> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Falha ao baixar arquivo do storage (${path}): não existe (fake).`);
    return { data: Buffer.from(file.data), contentType: file.contentType };
  }

  // --- Helpers de teste (não fazem parte da interface FileStorage) ---

  has(path: string): boolean {
    return this.files.has(path);
  }

  get(path: string): { data: Uint8Array; contentType: string } | undefined {
    return this.files.get(path);
  }

  list(): string[] {
    return [...this.files.keys()];
  }

  reset(): void {
    this.files.clear();
  }
}
