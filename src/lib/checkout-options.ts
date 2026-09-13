// Escolha da opção de entrega (sacola → checkout), sem React: mantém a
// escolha se ela ainda existe, senão cai na primeira (a lista vem ordenada —
// motoboy de hoje, depois preço). O parâmetro ?frete= é uma optionKey.
export function pickDefaultOptionKey(options: readonly { optionKey: string }[], current: string | null | undefined): string | null {
  if (current && options.some((option) => option.optionKey === current)) return current;
  return options[0]?.optionKey ?? null;
}

/** ?frete= vindo da URL: só o formato que a sacola gera (uuid, ou uuid:dia:HH:MM). */
export function parseFreteParam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return /^[0-9a-f-]{36}(:\d{4}-\d{2}-\d{2}:\d{2}:\d{2})?$/i.test(value) ? value : null;
}

/** A chave é de uma janela de motoboy (uuid:dia:HH:MM), não de uma faixa simples. */
export function isWindowOptionKey(optionKey: string | null | undefined): boolean {
  return !!optionKey && optionKey.includes(":");
}
