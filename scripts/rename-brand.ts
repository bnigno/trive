// Troca settings.store_name da grafia antiga ("TRIVË") para a oficial (TRIVÉ)
// pelo mesmo caminho do painel: updateSetting, com audit_log. Idempotente e
// conservador — se o dono já personalizou o nome, não mexe.
// Uso (env no shell ou via dotenv, como os demais scripts):
//   DOTENV_CONFIG_PATH=.env.prod.local node --require dotenv/config --import tsx scripts/rename-brand.ts
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { STORE_NAME_DEFAULT } from "@/lib/brand";
import { getSettingsMap, updateSetting } from "@/services/settings";

const OLD_SPELLING = "TRIVË";

async function main() {
  const db = getDb();
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "owner"))
    .limit(1);
  if (!owner) throw new Error("Nenhum owner encontrado para assinar o audit.");

  const map = await getSettingsMap(db, ["store_name"]);
  const current = typeof map.store_name === "string" ? map.store_name.trim() : "";

  if (current === STORE_NAME_DEFAULT) {
    console.log(`store_name já é "${STORE_NAME_DEFAULT}". Nada a fazer.`);
    return;
  }
  if (current !== "" && current !== OLD_SPELLING) {
    console.log(`store_name é "${current}" (personalizado) — não mexo.`);
    return;
  }

  await updateSetting(db, {
    key: "store_name",
    value: STORE_NAME_DEFAULT,
    userId: owner.id,
  });
  console.log(`store_name: "${current || "(vazio)"}" → "${STORE_NAME_DEFAULT}" (com audit).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
