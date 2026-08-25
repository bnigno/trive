#!/usr/bin/env node
// Impede que segredos de servidor e acesso direto ao banco vazem para código
// que roda no navegador:
//   1. SUPABASE_SERVICE_ROLE_KEY não pode aparecer em arquivo com "use client"
//      nem em src/components/**.
//   2. Arquivo client ("use client" ou *client.tsx) não pode importar de src/db.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const DB_DIR = join(ROOT, "src", "db");
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SERVICE_ROLE_PATTERN = /SUPABASE_SERVICE_ROLE_KEY/;
const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

function walk(dir) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

function hasUseClientDirective(source) {
  const lines = source.split(/\r?\n/);
  let insideBlockComment = false;
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (insideBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2).trim();
    }
    insideBlockComment = false;
    if (line === "") continue;
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) insideBlockComment = true;
      continue;
    }
    // Prólogo de diretivas: apenas literais de string no topo do arquivo.
    const directive = line.match(/^["']([^"']*)["'];?$/);
    if (!directive) return false;
    if (directive[1] === "use client") return true;
  }
  return false;
}

function importsFromDb(source, filePath) {
  const matches = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier === "@/db" || specifier.startsWith("@/db/")) {
      matches.push(specifier);
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = resolve(dirname(filePath), specifier);
      if (resolved === DB_DIR || resolved.startsWith(DB_DIR + sep)) {
        matches.push(specifier);
      }
    }
  }
  return matches;
}

const violations = [];

for (const filePath of walk(SRC_DIR)) {
  const relativePath = relative(ROOT, filePath);
  const source = readFileSync(filePath, "utf8");
  const isClientFile =
    hasUseClientDirective(source) || basename(filePath) === "client.tsx";
  const isComponentFile = filePath.startsWith(join(SRC_DIR, "components") + sep);

  if ((isClientFile || isComponentFile) && SERVICE_ROLE_PATTERN.test(source)) {
    violations.push(
      `${relativePath}: menciona SUPABASE_SERVICE_ROLE_KEY em código de cliente. ` +
        "Essa chave dá acesso TOTAL ao banco e só pode existir em código de servidor.",
    );
  }

  if (isClientFile) {
    for (const specifier of importsFromDb(source, filePath)) {
      violations.push(
        `${relativePath}: componente cliente importa de src/db ("${specifier}"). ` +
          "Acesso ao banco só pode acontecer no servidor (services/actions/routes).",
      );
    }
  }
}

if (violations.length > 0) {
  console.error("ERRO: possível vazamento de segredo/banco para o cliente.\n");
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  console.error(
    "\nMova o código para o servidor (server action, route handler ou service) e " +
      "passe ao cliente apenas os dados já prontos.",
  );
  process.exit(1);
}

console.log(
  "check-client-secrets: nenhum segredo de servidor nem import de src/db em código de cliente. OK.",
);
