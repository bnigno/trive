import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Varredura dos arquivos do painel: garante que toda página, route handler e
 * server action de área do proprietário chama `requireOwner` — esconder o
 * item do menu não protege nada contra quem digita a URL.
 *
 * Roda em node puro (fs + regex), sem banco e sem subir o Next.
 *
 * Rede de segurança permanente: quem criar uma página nova em área do dono e
 * esquecer o guard quebra a suíte.
 */

const PROTECTED_ROOT = path.join(
  process.cwd(),
  "src",
  "app",
  "admin",
  "(protected)",
);

/**
 * Diretórios cujo conteúdo inteiro é do proprietário. `skipDirs` corta
 * subpastas que pertencem a outra área (nome simples, comparado em qualquer
 * nível): /whatsapp é configuração do dono, mas /whatsapp/conversas é a
 * central de atendimento que a equipe usa.
 */
const OWNER_ONLY_DIRS: Array<{ dir: string; skipDirs?: string[] }> = [
  { dir: "fornecedores" },
  { dir: "precos" },
  { dir: "frete" },
  { dir: "financeiro" },
  { dir: "configuracoes" },
  { dir: "whatsapp", skipDirs: ["conversas"] },
  { dir: "relatorios" },
  { dir: "cupons" },
  { dir: "fila" },
  { dir: "usuarios" },
  // Produtos é área compartilhada, mas o cadastro novo pede o custo inicial
  // (e dispara precificação): só o dono cria produto.
  { dir: path.join("produtos", "novo") },
];

/**
 * Páginas sem guard próprio, por motivo declarado. Qualquer outra página sob
 * (protected) precisa chamar requireUser ou requireOwner.
 */
const PAGES_WITHOUT_GUARD = new Set([
  // Só valida o UUID e redireciona para /conversas?c=<id>: não lê dado nenhum.
  "whatsapp/conversas/[id]/page.tsx",
  // É justamente a tela de "você não tem acesso" — precisa abrir para a equipe.
  "sem-acesso/page.tsx",
]);

function walk(dir: string, skipDirs: ReadonlySet<string>): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      found.push(...walk(full, skipDirs));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

/** Caminho relativo ao (protected), sempre com "/" — é o que aparece no erro. */
function rel(fullPath: string): string {
  return path.relative(PROTECTED_ROOT, fullPath).split(path.sep).join("/");
}

function read(fullPath: string): string {
  return fs.readFileSync(fullPath, "utf8");
}

/** Corpo de cada `export async function NAME` do arquivo, na ordem. */
function exportedActionBodies(
  source: string,
): Array<{ name: string; body: string }> {
  const matches = [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)];
  return matches.map((match, index) => {
    const start = match.index;
    const end = matches[index + 1]?.index ?? source.length;
    return { name: match[1], body: source.slice(start, end) };
  });
}

const ownerOnlyFiles = OWNER_ONLY_DIRS.flatMap(({ dir, skipDirs }) =>
  walk(path.join(PROTECTED_ROOT, dir), new Set(skipDirs ?? [])),
);

const allProtectedFiles = walk(PROTECTED_ROOT, new Set());

describe("guards de papel no painel (varredura de arquivos)", () => {
  it("encontra os diretórios do proprietário no lugar esperado", () => {
    // Se alguém renomear uma pasta, a varredura ficaria vazia e passaria
    // vazia — este teste é o alarme contra o falso positivo.
    for (const { dir } of OWNER_ONLY_DIRS) {
      expect(
        fs.existsSync(path.join(PROTECTED_ROOT, dir)),
        `diretório sumiu: ${dir}`,
      ).toBe(true);
    }
    expect(ownerOnlyFiles.length).toBeGreaterThan(10);
  });

  it("toda página e route handler de área do dono usa requireOwner", () => {
    const offenders: string[] = [];
    for (const file of ownerOnlyFiles) {
      const base = path.basename(file);
      if (base !== "page.tsx" && base !== "route.ts") continue;
      const source = read(file);
      if (!source.includes("requireOwner(")) {
        offenders.push(`${rel(file)}: falta requireOwner()`);
      }
      if (source.includes("requireUser(")) {
        offenders.push(`${rel(file)}: ainda usa requireUser()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("toda action exportada de área do dono chama requireOwner", () => {
    const offenders: string[] = [];
    for (const file of ownerOnlyFiles) {
      if (path.basename(file) !== "actions.ts") continue;
      const source = read(file);
      if (source.includes("requireUser(")) {
        offenders.push(`${rel(file)}: ainda usa requireUser()`);
      }
      const actions = exportedActionBodies(source);
      expect(
        actions.length,
        `${rel(file)}: nenhuma action exportada`,
      ).toBeGreaterThan(0);
      for (const action of actions) {
        if (!action.body.includes("requireOwner(")) {
          offenders.push(`${rel(file)} → ${action.name}: falta requireOwner()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("toda página sob (protected) tem algum guard de sessão", () => {
    const offenders: string[] = [];
    for (const file of allProtectedFiles) {
      if (path.basename(file) !== "page.tsx") continue;
      const relative = rel(file);
      if (PAGES_WITHOUT_GUARD.has(relative)) continue;
      const source = read(file);
      if (
        !source.includes("requireUser(") &&
        !source.includes("requireOwner(")
      ) {
        offenders.push(`${relative}: sem requireUser() nem requireOwner()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("as exceções da whitelist continuam sendo o que dizem ser", () => {
    for (const relative of PAGES_WITHOUT_GUARD) {
      const full = path.join(PROTECTED_ROOT, ...relative.split("/"));
      expect(fs.existsSync(full), `whitelist órfã: ${relative}`).toBe(true);
    }
    const redirectPage = read(
      path.join(PROTECTED_ROOT, "whatsapp/conversas/[id]/page.tsx"),
    );
    expect(redirectPage).toContain("permanentRedirect(");
    expect(redirectPage).not.toContain("getDb(");
  });
});
