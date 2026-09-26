// O vídeo da peça é só para o Instagram (feito com IA, com o aviso): nunca
// vira prova de caimento na vitrine, na página da peça, nos links públicos
// nem nas mensagens da Lia (oferta precisa, CDC arts. 31 e 37). Este teste
// varre o código dessas bordas atrás de qualquer leitura dos vídeos.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const PUBLIC_DIRS = ["app/(store)", "app/api", "app/ig", "app/provador", "app/entrega", "core/bot", "services/bot"];
const PUBLIC_SERVICE_FILE = /^(store-|wa-|bot|lia-)/;

function publicFiles(): string[] {
  const dirs = PUBLIC_DIRS.map((dir) => path.join(SRC, dir)).flatMap((dir) => {
    try {
      return filesUnder(dir);
    } catch {
      return [];
    }
  });
  const services = readdirSync(path.join(SRC, "services"))
    .filter((name) => PUBLIC_SERVICE_FILE.test(name) && /\.(ts|tsx)$/.test(name))
    .map((name) => path.join(SRC, "services", name));
  return [...dirs, ...services];
}

/** Lê os vídeos: importa os services do vídeo, a tabela pelo schema, ou o nome da tabela em SQL. */
function readsVideos(source: string): boolean {
  if (/from "@\/services\/studio-video(-generate)?"/.test(source)) return true;
  if (/studio_videos/.test(source)) return true;
  return /import\s*\{[^}]*\bstudioVideos\b[^}]*\}\s*from\s*"@\/db\/schema"/.test(source);
}

describe("o vídeo da peça nunca sai do painel", () => {
  it("a varredura enxerga as bordas públicas (vitrine, API, links, Lia)", () => {
    const files = publicFiles();
    expect(files.some((file) => file.includes(`${path.sep}(store)${path.sep}`))).toBe(true);
    expect(files.some((file) => file.endsWith("wa-bot.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("store-catalog.ts"))).toBe(true);
  });

  it("nenhum arquivo da vitrine, da API pública ou da Lia lê os vídeos", () => {
    const offenders = publicFiles().filter((file) => readsVideos(readFileSync(file, "utf8")));
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it("o detector pega as três formas de ler", () => {
    expect(readsVideos('import { listStudioVideoPanel } from "@/services/studio-video";')).toBe(true);
    expect(readsVideos('import { products, studioVideos } from "@/db/schema";')).toBe(true);
    expect(readsVideos("select * from studio_videos")).toBe(true);
    expect(readsVideos("const summary = { studioVideos: 1 };")).toBe(false);
  });
});
