// A loja se chama TRIVÉ. O redesign usou "a maison" como substantivo para a
// loja ("Saiu da maison", "fale com a maison") e o dono viu o nome errado no
// site e no WhatsApp. Este teste varre o código de produção e falha se a
// palavra voltar fora das exceções: a tagline do logo ("Maison Féminine"), o
// domínio (trivemaison.com.br), a constante STORE_TAGLINE e a proibição
// explícita no prompt da Lia. Comentários não contam.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(process.cwd(), "src");
const ALLOWED = [/Maison Féminine/g, /trivemaison/gi, /STORE_TAGLINE/g, /nunca a chame de "maison"/g];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

// Tira comentários de linha e de bloco (os do JSX também); texto de produção fica.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/(^|[^:"'`])\/\/(?![^"'`]*["'`]).*$/, "$1"))
    .join("\n");
}

describe("voz da marca: a loja se chama TRIVÉ", () => {
  it("nenhum texto de produção chama a loja de 'maison'", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      let text = stripComments(readFileSync(file, "utf8"));
      for (const allowed of ALLOWED) text = text.replace(allowed, "");
      text.split("\n").forEach((line, index) => {
        if (/\bmaison\b/i.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
