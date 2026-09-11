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
  const parsed = z.enum(["post", "story"]).safeParse(format);
  if (!parsed.success) return new Response("Formato inválido.", { status: 404 });

  let file;
  try {
    file = await getProductPostFile(getDb(), getFileStorage(), {
      productId: id,
      format: parsed.data,
    });
  } catch (error) {
    if (error instanceof ServiceError) return new Response(error.message, { status: 409 });
    throw error;
  }
  if (!file) return new Response("Ainda não desenhado.", { status: 404 });

  const download = new URL(request.url).searchParams.get("download") === "1";
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, max-age=60",
      ...(download
        ? { "Content-Disposition": `attachment; filename="${parsed.data}.jpg"` }
        : {}),
    },
  });
}
