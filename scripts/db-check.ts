// Testa conexão com o banco usando a DATABASE_URL de um arquivo .env; tenta variantes de senha.
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const envPath = process.argv[2];
const raw = readFileSync(envPath, "utf8");
const m = raw.match(/^DATABASE_URL=(.+)$/m);
if (!m) throw new Error("DATABASE_URL não encontrada em " + envPath);
const baseUrl = m[1].trim();

const candidates = [baseUrl];
if (baseUrl.includes("Casasitio185.@")) {
  candidates.push(baseUrl.replace("Casasitio185.@", "Casasitio185@"));
}

async function tryConnect(url: string): Promise<boolean> {
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 12 });
  try {
    const r = await sql`select 1 as ok`;
    await sql.end();
    return r[0].ok === 1;
  } catch (e) {
    await sql.end({ timeout: 1 }).catch(() => {});
    console.log("  falhou:", (e as Error).message.slice(0, 120));
    return false;
  }
}

async function main() {
  for (const url of candidates) {
    const variant = url === baseUrl ? "senha com ponto final" : "senha sem ponto final";
    console.log("tentando:", variant);
    if (await tryConnect(url)) {
      console.log("CONECTOU com", variant);
      if (url !== baseUrl) {
        writeFileSync(envPath, raw.replace(baseUrl, url));
        console.log("(arquivo corrigido para a variante que funciona)");
      }
      process.exit(0);
    }
  }
  console.log("NENHUMA variante conectou");
  process.exit(1);
}

void main();
