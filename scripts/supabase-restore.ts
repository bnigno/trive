// Restaura (despausa) um projeto Supabase pela Management API e espera ele
// ficar saudável. O plano gratuito pausa projetos parados; sem o dev, o
// preview da Vercel não builda.
// Uso: npx tsx scripts/supabase-restore.ts <ref>
// Token: .env.supabase.local com SUPABASE_ACCESS_TOKEN=sbp_… (criado em
// https://supabase.com/dashboard/account/tokens). O script lê o arquivo
// internamente — nunca passe o token na linha de comando.
import { readFileSync } from "node:fs";

const API = "https://api.supabase.com/v1";
const ref = process.argv[2];
if (!ref) {
  console.error("Uso: npx tsx scripts/supabase-restore.ts <ref-do-projeto>");
  process.exit(1);
}

function loadToken(): string {
  const raw = readFileSync(".env.supabase.local", "utf8");
  const match = raw.match(/^SUPABASE_ACCESS_TOKEN=\s*"?([^"\s]+)"?/m);
  if (!match) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN não encontrado em .env.supabase.local",
    );
  }
  return match[1];
}

const token = loadToken();

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // resposta sem JSON
  }
  return { status: res.status, body };
}

type Project = { id: string; name: string; status: string; region?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getProject(): Promise<Project | null> {
  const res = await api("/projects");
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error(
      `Não consegui listar os projetos (${res.status}). Token inválido ou sem permissão?`,
    );
  }
  return (res.body as Project[]).find((p) => p.id === ref) ?? null;
}

async function main() {
  const project = await getProject();
  if (!project) {
    console.error(
      `Projeto ${ref} não aparece na sua conta. Foi apagado? Então precisa ser recriado.`,
    );
    process.exit(2);
  }
  console.log(`Projeto "${project.name}" (${ref}): status ${project.status}`);

  if (project.status === "ACTIVE_HEALTHY") {
    console.log("Já está ativo. Nada a fazer.");
    return;
  }

  if (project.status === "INACTIVE") {
    const restore = await api(`/projects/${ref}/restore`, {
      method: "POST",
      body: "{}",
    });
    if (restore.status >= 300) {
      console.error("Falha ao pedir a restauração:", restore.status, restore.body);
      process.exit(3);
    }
    console.log("Restauração pedida. Aguardando o projeto ficar saudável…");
  } else {
    console.log(`Status ${project.status}: aguardando…`);
  }

  for (let i = 0; i < 60; i++) {
    await sleep(10_000);
    const current = await getProject();
    console.log(`  ${new Date().toLocaleTimeString("pt-BR")} → ${current?.status}`);
    if (current?.status === "ACTIVE_HEALTHY") {
      console.log("Projeto ativo e saudável.");
      return;
    }
  }
  console.error("Passaram 10 minutos e o projeto ainda não ficou saudável. Confira no painel.");
  process.exit(4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
