// Configura o projeto na Vercel: cria/vincula ao repo GitHub, envia variáveis de
// ambiente (Production ← .env.prod.local, Preview/Development ← .env.local) e
// dispara o primeiro deploy via deploy hook.
// Uso: npx tsx scripts/vercel-setup.ts
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PROJECT_NAME = "trive";
const GITHUB_REPO = "bnigno/trive";

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
const devEnv = loadEnv(".env.local");

// Resposta da API tratada como any: script operacional de uso pontual, campos validados no uso.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.vercel.com${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const KEYS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ADAPTER_MODE",
  "JOBS_ROUTE_SECRET",
  "ZAPI_WEBHOOK_SECRET",
];

function envPayload(source: Record<string, string>, target: string[]) {
  return KEYS.filter((k) => source[k]).map((key) => ({
    key,
    value: source[key],
    target,
    type: key.startsWith("NEXT_PUBLIC_") || key === "ADAPTER_MODE" ? "plain" : "encrypted",
  }));
}

async function main() {
  const user = await api("/v2/user");
  if (user.status !== 200) {
    console.error("Token inválido ou expirado:", user.status);
    process.exit(1);
  }
  console.log(`Autenticado na Vercel como: ${user.body.user?.username ?? "?"}`);

  const teams = await api("/v2/teams");
  const team = (teams.body.teams ?? [])[0];
  const teamQS = team ? `?teamId=${team.id}` : "";
  console.log(`Escopo: ${team?.name ?? "conta pessoal"}`);

  let project = await api(`/v9/projects/${PROJECT_NAME}${teamQS}`);
  if (project.status === 404) {
    console.log("Projeto não existe — criando e vinculando ao GitHub…");
    project = await api(`/v11/projects${teamQS}`, {
      method: "POST",
      body: JSON.stringify({
        name: PROJECT_NAME,
        framework: "nextjs",
        gitRepository: { type: "github", repo: GITHUB_REPO },
      }),
    });
    if (project.status !== 200 && project.status !== 201) {
      console.error("Falha ao criar projeto:", project.status, JSON.stringify(project.body).slice(0, 400));
      console.error("Se o erro citar o app do GitHub, instale-o uma vez em: https://vercel.com/new (importar bnigno/trive)");
      process.exit(1);
    }
    console.log("Projeto criado e vinculado ao repo ✓");
  } else if (project.status === 200) {
    console.log("Projeto já existia — reutilizando ✓");
  } else {
    console.error("Erro ao consultar projeto:", project.status, JSON.stringify(project.body).slice(0, 300));
    process.exit(1);
  }
  const projectId = project.body.id;

  const allEnvs = [
    ...envPayload(prodEnv, ["production"]),
    ...envPayload(devEnv, ["preview", "development"]),
  ];
  const envRes = await api(`/v10/projects/${projectId}/env${teamQS ? teamQS + "&" : "?"}upsert=true`, {
    method: "POST",
    body: JSON.stringify(allEnvs),
  });
  if (envRes.status !== 200 && envRes.status !== 201) {
    console.error("Falha ao gravar variáveis:", envRes.status, JSON.stringify(envRes.body).slice(0, 400));
    process.exit(1);
  }
  const failed = envRes.body?.failed ?? [];
  console.log(`Variáveis gravadas: ${allEnvs.length - failed.length}/${allEnvs.length}` + (failed.length ? ` — falhas: ${JSON.stringify(failed).slice(0, 300)}` : " ✓"));

  const hook = await api(`/v1/projects/${projectId}/deploy-hooks${teamQS}`, {
    method: "POST",
    body: JSON.stringify({ name: "setup-inicial", ref: "main" }),
  });
  const hookUrl =
    hook.body?.link?.deployHooks?.at?.(-1)?.url ??
    hook.body?.links?.deployHooks?.at?.(-1)?.url ??
    hook.body?.url;
  if (!hookUrl) {
    console.error("Não consegui criar o deploy hook:", hook.status, JSON.stringify(hook.body).slice(0, 300));
    console.error("Alternativa: qualquer git push dispara o deploy automaticamente.");
    process.exit(1);
  }
  const fire = await fetch(hookUrl, { method: "POST" });
  console.log(`Deploy disparado (hook HTTP ${fire.status}) — acompanhando…`);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const deps = await api(`/v6/deployments${teamQS ? teamQS + "&" : "?"}projectId=${projectId}&limit=1`);
    const d = deps.body?.deployments?.[0];
    if (!d) continue;
    process.stdout.write(`  estado: ${d.readyState ?? d.state}\n`);
    if (d.readyState === "READY") {
      console.log(`DEPLOY PRONTO: https://${d.url}`);
      const domains = await api(`/v9/projects/${projectId}/domains${teamQS}`);
      for (const dom of domains.body?.domains ?? []) console.log(`  domínio: https://${dom.name}`);
      return;
    }
    if (d.readyState === "ERROR" || d.readyState === "CANCELED") {
      console.error(`Deploy terminou em ${d.readyState} — veja os logs em https://vercel.com`);
      process.exit(1);
    }
  }
  console.error("Tempo esgotado acompanhando o deploy (veja https://vercel.com).");
  process.exit(1);
}

void main();
