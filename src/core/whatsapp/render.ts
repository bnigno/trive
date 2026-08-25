// Render PURO de templates de WhatsApp: substitui {{chave}} pelos valores
// informados. Chave ausente vira '' — em produção uma variável faltando
// nunca pode derrubar o envio (mensagem sai incompleta, não falha).

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function renderTemplate(
  bodyTemplate: string,
  vars: Record<string, string>,
): string {
  return bodyTemplate.replace(VARIABLE_PATTERN, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? (vars[key] ?? "") : "",
  );
}

/** Lista as chaves {{...}} do template, sem repetição, na ordem de aparição. */
export function extractVariables(bodyTemplate: string): string[] {
  const seen = new Set<string>();
  const variables: string[] = [];
  for (const match of bodyTemplate.matchAll(VARIABLE_PATTERN)) {
    const key = match[1];
    if (key !== undefined && !seen.has(key)) {
      seen.add(key);
      variables.push(key);
    }
  }
  return variables;
}
