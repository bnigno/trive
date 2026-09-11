// Os interruptores da Central do WhatsApp salvam na hora. O tipo do
// componente (client) e o enum da action (servidor) são listas separadas:
// quando uma cresce sem a outra, o botão volta sozinho e o recurso não
// desliga — foi o que aconteceu com "catalog_draft_enabled". Este teste
// mantém as duas listas iguais (e dentro das chaves permitidas).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALLOWED_SETTING_KEYS } from "@/services/settings";

const ROOT = path.join(process.cwd(), "src/app/admin/(protected)/whatsapp");

function keysBetween(source: string, start: string, end: string): string[] {
  const from = source.indexOf(start);
  expect(from, `trecho não encontrado: ${start}`).toBeGreaterThan(-1);
  const block = source.slice(from, source.indexOf(end, from));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

describe("interruptores da Central do WhatsApp", () => {
  const forms = readFileSync(path.join(ROOT, "forms.tsx"), "utf8");
  const actions = readFileSync(path.join(ROOT, "actions.ts"), "utf8");

  it("o tipo do componente e o enum da action listam as MESMAS chaves", () => {
    const noComponente = keysBetween(forms, "settingKey:", "checked: boolean");
    const naAction = keysBetween(actions, "const toggleKeySchema = z.enum([", "]);");
    expect(noComponente.length).toBeGreaterThan(4);
    expect([...naAction].sort()).toEqual([...noComponente].sort());
  });

  it("toda chave de interruptor é uma setting conhecida", () => {
    for (const key of keysBetween(actions, "const toggleKeySchema = z.enum([", "]);")) {
      expect(ALLOWED_SETTING_KEYS, `setting desconhecida: ${key}`).toContain(key);
    }
  });
});
