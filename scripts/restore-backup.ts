// Restaura um backup do banco (arquivo .dump gerado pelo workflow Backup do
// GitHub) em um banco de destino, com confirmação interativa.
//
// COMO BAIXAR O BACKUP MAIS RECENTE (precisa do GitHub CLI, `gh`):
//   gh run list --workflow=backup.yml --limit 5   # lista as execuções recentes
//   gh run download --name trive-backup           # baixa o artifact da mais recente
//   gh run download <RUN_ID> --name trive-backup  # ou de uma execução específica
// O arquivo baixado se chama trive-backup-AAAA-MM-DD.dump.
//
// USO:
//   pnpm tsx scripts/restore-backup.ts <arquivo.dump> <env-file>
//   ex.: pnpm tsx scripts/restore-backup.ts trive-backup-2026-08-25.dump .env.local
//
// O env-file precisa conter a DATABASE_URL do banco de DESTINO. O script roda
// `pg_restore --clean --if-exists --no-owner` (apaga cada tabela do destino e
// recria com o conteúdo do backup). Se o destino parecer o banco de PRODUÇÃO
// (mesmo host da DATABASE_URL de .env.prod.local), exige confirmação dupla:
// além do "s" normal, é preciso digitar RESTAURAR PRODUCAO por extenso.
//
// Teste trimestral de restauração: docs/runbook.md.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const PROD_ENV_FILE = ".env.prod.local";
const PROD_PHRASE = "RESTAURAR PRODUCAO";

function fail(message: string): never {
  console.error(`\nERRO: ${message}`);
  process.exit(1);
}

function readDatabaseUrl(envPath: string): string {
  const raw = readFileSync(envPath, "utf8");
  const match = raw.match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
  if (!match) fail(`DATABASE_URL não encontrada em ${envPath}.`);
  return match[1].trim().replace(/^["']|["']$/g, "");
}

// Extrai o host da URL sem depender de new URL() — senhas com caracteres
// especiais não codificados (ex.: "." ou "@") quebrariam o parse estrito.
function extractHost(databaseUrl: string): string {
  const match = databaseUrl.match(/@([^@/?#]+?)(?::\d+)?(?:[/?#]|$)/);
  return match ? match[1].toLowerCase() : "";
}

function extractDbName(databaseUrl: string): string {
  const match = databaseUrl.match(/\/([^/?#]+)(?:[?#]|$)/);
  return match ? match[1] : "(não identificado)";
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function main(): Promise<void> {
  const [, , dumpArg, envArg] = process.argv;
  if (!dumpArg || !envArg) {
    console.error(
      "Uso: pnpm tsx scripts/restore-backup.ts <arquivo.dump> <env-file>\n" +
        "ex.: pnpm tsx scripts/restore-backup.ts trive-backup-2026-08-25.dump .env.local\n\n" +
        "Para baixar o backup mais recente: gh run download --name trive-backup",
    );
    process.exit(1);
  }

  const dumpPath = resolve(dumpArg);
  const envPath = resolve(envArg);
  if (!existsSync(dumpPath)) fail(`arquivo de backup não encontrado: ${dumpPath}`);
  if (!existsSync(envPath)) fail(`env-file não encontrado: ${envPath}`);

  const version = spawnSync("pg_restore", ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    fail(
      "pg_restore não está instalado (faz parte do PostgreSQL).\n" +
        "No macOS: brew install libpq && brew link --force libpq",
    );
  }

  console.log("Passo 1/4 — Lendo o destino da restauração...");
  const targetUrl = readDatabaseUrl(envPath);
  const targetHost = extractHost(targetUrl);
  const targetDb = extractDbName(targetUrl);

  const prodEnvPath = resolve(PROD_ENV_FILE);
  let prodHost: string | null = null;
  if (existsSync(prodEnvPath)) {
    prodHost = extractHost(readDatabaseUrl(prodEnvPath));
  }
  // Com .env.prod.local presente, produção é ter o mesmo host. Sem ele, somos
  // conservadores: qualquer host que não seja local é tratado como produção.
  const looksLikeProd = prodHost
    ? targetHost === prodHost
    : !isLocalHost(targetHost);

  console.log("\nPasso 2/4 — Confira antes de continuar:");
  console.log(`  Backup   : ${dumpPath}`);
  console.log(`  Env-file : ${envPath}`);
  console.log(`  Host     : ${targetHost || "(não identificado)"}`);
  console.log(`  Banco    : ${targetDb}`);
  console.log(
    "\nA restauração APAGA as tabelas do banco de destino e as recria com o\n" +
      "conteúdo do backup. O que existe hoje nesse banco será substituído.",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const first = await rl.question("\nContinuar? (digite s para sim) ");
    if (first.trim().toLowerCase() !== "s") {
      console.log("Ok, nada foi feito. Até a próxima.");
      process.exit(0);
    }

    if (looksLikeProd) {
      console.log(
        `\nATENÇÃO: esse destino parece ser o banco de PRODUÇÃO` +
          (prodHost ? ` (mesmo host de ${PROD_ENV_FILE}).` : ".") +
          "\nRestaurar aqui substitui os dados REAIS da loja: pedidos, clientes,\n" +
          "estoque — tudo volta para o momento em que o backup foi feito.",
      );
      const second = await rl.question(
        `\nPara confirmar, digite exatamente ${PROD_PHRASE} (ou Enter para cancelar): `,
      );
      if (second.trim() !== PROD_PHRASE) {
        console.log("Confirmação não confere. Nada foi feito — e ainda bem.");
        process.exit(0);
      }
    }
  } finally {
    rl.close();
  }

  console.log("\nPasso 3/4 — Restaurando (pode levar alguns minutos)...");
  const restore = spawnSync(
    "pg_restore",
    ["--clean", "--if-exists", "--no-owner", "--dbname", targetUrl, dumpPath],
    { stdio: "inherit" },
  );
  if (restore.status !== 0) {
    fail(
      "a restauração terminou com erro (veja as mensagens acima).\n" +
        "O banco de destino pode ter ficado incompleto — rode o script de novo\n" +
        "ou peça ajuda ao assistente no Claude Code.",
    );
  }

  console.log(
    "\nPasso 4/4 — Pronto! Restauração concluída sem erros.\n" +
      "Confira abrindo o sistema apontado para esse banco e conferindo se os\n" +
      "pedidos e produtos estão lá. Teste trimestral: docs/runbook.md.",
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
