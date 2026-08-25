// Envia variáveis selecionadas de .env.prod.local para o escopo Production
// do projeto na Vercel (upsert). Uso: npx tsx scripts/vercel-env-sync.ts KEY1 KEY2 ...
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PROJECT_NAME = "trive";

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path.join(ROOT, file), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const token = loadEnv(".env.vercel.local").VERCEL_TOKEN;
const prodEnv = loadEnv(".env.prod.local");
const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error("Informe as chaves a enviar. Ex.: npx tsx scripts/vercel-env-sync.ts INNGEST_EVENT_KEY");
  process.exit(1);
}

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`https://api.vercel.com${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  const teams = await api("/v2/teams");
  const team = (teams.body.teams ?? [])[0];
  const teamQS = team ? `?teamId=${team.id}` : "";
  const project = await api(`/v9/projects/${PROJECT_NAME}${teamQS}`);
  if (project.status !== 200) {
    console.error("Projeto não encontrado na Vercel (token expirado?):", project.status);
    process.exit(1);
  }
  const payload = keys
    .filter((k) => prodEnv[k] !== undefined && prodEnv[k] !== "")
    .map((key) => ({
      key,
      value: prodEnv[key],
      target: ["production"],
      type: key.startsWith("NEXT_PUBLIC_") ? "plain" : "encrypted",
    }));
  const res = await api(`/v10/projects/${project.body.id}/env${teamQS ? teamQS + "&" : "?"}upsert=true`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status !== 200 && res.status !== 201) {
    console.error("Falha ao gravar variáveis:", res.status, JSON.stringify(res.body).slice(0, 300));
    process.exit(1);
  }
  console.log(`Variáveis gravadas na Vercel (Production): ${payload.map((p) => p.key).join(", ")}`);
  console.log("Lembre-se: um novo deploy é necessário para as funções lerem os valores.");
}

void main();
