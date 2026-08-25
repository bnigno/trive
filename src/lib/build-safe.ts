/**
 * Páginas estáticas da loja (home, legais, sitemap) consultam o banco no
 * momento do BUILD (ISR). No CI não existe DATABASE_URL — lá, e SOMENTE lá,
 * devolvemos o fallback para o build compilar; em qualquer ambiente com
 * banco configurado o erro real sobe normalmente.
 */
export async function tryOrBuildFallback<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (process.env.DATABASE_URL) throw error;
    console.warn("[build] Sem DATABASE_URL — usando fallback vazio para pré-renderização.");
    return fallback;
  }
}
