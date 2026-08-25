#!/usr/bin/env node
// Bloqueia migrações destrutivas (DROP TABLE / DROP COLUMN / TRUNCATE) que não
// foram aprovadas explicitamente com o marcador "-- destructive: approved" na
// linha anterior ao comando.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "drizzle");
const DESTRUCTIVE_PATTERN = /\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE)\b/i;
const APPROVAL_MARKER = "-- destructive: approved";

let sqlFiles = [];
try {
  sqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
} catch {
  console.log(
    "check-migrations: diretório drizzle/ ausente — nenhuma migração para verificar. OK.",
  );
  process.exit(0);
}

const violations = [];

for (const fileName of sqlFiles) {
  const filePath = join(MIGRATIONS_DIR, fileName);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = line.match(DESTRUCTIVE_PATTERN);
    if (!match) return;

    const previousLine = index > 0 ? lines[index - 1] : "";
    const approved =
      previousLine.includes(APPROVAL_MARKER) || line.includes(APPROVAL_MARKER);
    if (!approved) {
      violations.push({
        file: `drizzle/${fileName}`,
        line: index + 1,
        command: match[1].replace(/\s+/g, " ").toUpperCase(),
      });
    }
  });
}

if (violations.length > 0) {
  console.error("ERRO: migração destrutiva sem aprovação explícita.\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.command}`);
  }
  console.error(
    [
      "",
      "Comandos DROP TABLE, DROP COLUMN e TRUNCATE apagam dados de forma irreversível.",
      "Se a mudança é realmente intencional, adicione o marcador abaixo na linha",
      "IMEDIATAMENTE ANTERIOR ao comando destrutivo, dentro do arquivo .sql:",
      "",
      `  ${APPROVAL_MARKER}`,
      "",
      "Antes de aprovar: confira se existe backup recente e se o dado não será mais necessário.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `check-migrations: ${sqlFiles.length} migração(ões) verificada(s), nenhuma operação destrutiva sem aprovação. OK.`,
);
