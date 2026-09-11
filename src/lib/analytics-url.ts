// Anonimização das URLs enviadas ao analytics — PURO. Links com token
// (/pedido/<token>, /lancamento/<token>) e cupons nunca saem do navegador:
// a rota vira /pedido ou /lancamento, e ?cupom= some.
export function anonymizeAnalyticsUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl, "https://trivemaison.com.br");
  } catch {
    return rawUrl;
  }
  if (/^\/pedido\/[^/]+/.test(url.pathname)) url.pathname = "/pedido";
  if (/^\/lancamento\/[^/]+/.test(url.pathname)) url.pathname = "/lancamento";
  if (url.searchParams.has("cupom")) url.searchParams.delete("cupom");
  const query = url.searchParams.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}
