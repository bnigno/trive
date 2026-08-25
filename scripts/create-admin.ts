// Cria (ou garante) um usuário administrador: conta no Supabase Auth + registro em public.users.
// Uso: npx tsx scripts/create-admin.ts <arquivo-env> <email> [role]
// A senha é gerada uma vez e guardada em .env.admin.local (coberto pelo .gitignore via .env*);
// execuções seguintes reutilizam a mesma senha, então dev e prod ficam com login idêntico.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

const [envFile, email, role = "owner"] = process.argv.slice(2);
if (!envFile || !email) {
  console.error("Uso: npx tsx scripts/create-admin.ts <arquivo-env> <email> [role]");
  process.exit(1);
}

const root = process.cwd();
const env: Record<string, string> = {};
for (const line of readFileSync(path.join(root, envFile), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const databaseUrl = env.DATABASE_URL;
if (!supabaseUrl || !serviceKey || !databaseUrl) {
  console.error(`Variáveis ausentes em ${envFile}.`);
  process.exit(1);
}

const credsPath = path.join(root, ".env.admin.local");
let password: string;
if (existsSync(credsPath)) {
  const m = readFileSync(credsPath, "utf8").match(/^ADMIN_PASSWORD=(.+)$/m);
  password = m ? m[1] : "";
}
if (!password!) {
  password = "Trv-" + randomBytes(9).toString("base64url");
  writeFileSync(credsPath, `ADMIN_EMAIL=${email}\nADMIN_PASSWORD=${password}\n`, { mode: 0o600 });
}

async function authAdmin(pathname: string, init?: RequestInit) {
  const res = await fetch(`${supabaseUrl}/auth/v1${pathname}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  let userId: string | undefined;
  const created = await authAdmin("/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status === 200 || created.status === 201) {
    userId = created.body.id;
    console.log(`Auth: usuário criado (${email}).`);
  } else {
    const list = await authAdmin(`/admin/users?page=1&per_page=100`);
    const found = (list.body.users ?? []).find(
      (u: { email?: string; id: string }) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (!found) {
      console.error("Falha ao criar e usuário não encontrado:", created.status, created.body);
      process.exit(1);
    }
    userId = found.id;
    console.log(`Auth: usuário já existia (${email}); reutilizando.`);
  }

  const sql = postgres(databaseUrl, { prepare: false, max: 1 });
  await sql`
    insert into users (id, email, full_name, role, is_active)
    values (${userId!}, ${email}, ${"Fabiano"}, ${role}, true)
    on conflict (id) do update set email = excluded.email, role = excluded.role, is_active = true
  `;
  await sql.end();
  console.log(`Banco: registro em users garantido com role '${role}'.`);
  console.log(`Credenciais em .env.admin.local`);
}

void main();
