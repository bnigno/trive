// A loja se chama TRIVÉ. O redesign usou "a maison" como substantivo para a
// loja ("Saiu da maison", "fale com a maison") e o dono viu o nome errado no
// site e no WhatsApp. Este teste varre o código de produção e falha se a
// palavra voltar fora das exceções: a tagline do logo ("Maison Féminine"), o
// domínio (trivemaison.com.br), a constante STORE_TAGLINE e a proibição
// explícita no prompt da Lia. Comentários não contam — separados pelo parser
// do TypeScript (regex confundia `accept="image/*"` com abertura de bloco).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
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

/** Só os tokens do código (strings, JSX, template, identificadores): comentário é trivia e fica de fora. */
function offendersIn(fileName: string, source: string): string[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // JSDoc vira nó filho no parser: é comentário, não conta.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.getChildCount(file) > 0) {
      node.getChildren(file).forEach(visit);
      return;
    }
    let text = node.getText(file);
    for (const allowed of ALLOWED) text = text.replace(allowed, "");
    if (/\bmaison\b/i.test(text)) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      found.push(`${fileName}:${line + 1}: ${node.getText(file).trim().slice(0, 100)}`);
    }
  };
  visit(file);
  return found;
}

describe("voz da marca: a loja se chama TRIVÉ", () => {
  it("a sonda prova o guarda: acusa texto de produção, ignora comentários e não se perde em image/*", () => {
    const probe = [
      '// a maison no comentário não conta',
      'export const a = "Saiu da maison"; // fim: "maison" no comentário de linha não conta',
      'export const b = `https://trivemaison.com.br`;',
      '/* bloco maison */',
      'export function C() { return <input accept="image/*" />; }',
      '/** doc */',
      'export function D() { return <p>Fale com a maison</p>; }',
      // Template literal com uma linha começando por //: é texto de produção (o token começa na linha 8).
      'export const e = `linha um\n// chame de maison\n`;',
      'export const f = "TRIVÉ — Maison Féminine";',
      'export const g = /\\/\\*maison\\*\\//;',
    ].join("\n");
    const lines = offendersIn("probe.tsx", probe).map((entry) => Number(entry.split(":")[1]));
    expect(lines).toEqual([2, 7, 8, 12]);
  });

  it("nenhum texto de produção chama a loja de 'maison'", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      offenders.push(...offendersIn(path.relative(process.cwd(), file), readFileSync(file, "utf8")));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
