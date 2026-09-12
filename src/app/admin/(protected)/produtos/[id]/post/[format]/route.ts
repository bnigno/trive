import { z } from "zod";

import { getFileStorage } from "@/adapters/storage";
import { getDb } from "@/db/client";
import { requireUser } from "@/services/auth";
import { getProductPostFile } from "@/services/product-posts";
import { ServiceError } from "@/services/settings";

/**
 * Serve o JPEG do post/story pela PRÓPRIA origem: o compartilhamento no
 * celular precisa do arquivo em memória, e buscar direto no Storage esbarra
 * em CORS. `?download=1` força o "salvar" no lugar de abrir.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; format: string }> },
): Promise<Response> {
  await requireUser();
  const { id, format } = await params;
  const parsed = z
    .union([z.enum(["post", "story"]), z.custom<`carousel-${number}`>((value) => /^carousel-\d{1,2}$/.test(String(value)))])
    .safeParse(format);
  if (!parsed.success) return new Response("Formato inválido.", { status: 404 });
  if (!z.uuid().safeParse(id).success) return new Response("Peça não encontrada.", { status: 404 });

  let file;
  try {
    file = await getProductPostFile(getDb(), getFileStorage(), {
      productId: id,
      format: parsed.data as "post" | "story" | `carousel-${number}`,
    });
  } catch (error) {
    if (error instanceof ServiceError) {
      const status = error.code === "nao_encontrado" ? 404 : 409;
      return new Response(error.message, { status });
    }
    throw error;
  }
  if (!file) return new Response("Ainda não desenhado.", { status: 404 });

  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      // A URL é fixa por peça e formato, mas o desenho muda quando o preço ou
      // a foto mudam: guardar 60 s devolveria a arte velha no "Atualizar".
      "Cache-Control": "private, no-store",
      // Nome com a peça e a cor: no iPhone o arquivo vai para Arquivos, e a
      // dona precisa reconhecê-lo depois.
      ...(download ? { "Content-Disposition": `attachment; filename="${file.filename}"` } : {}),
    },
  });
}
