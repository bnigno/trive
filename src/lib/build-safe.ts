/**
 * Páginas estáticas da loja (home, legais, sitemap) consultam o banco no
 * momento do BUILD (ISR). Dois casos em que isso não pode derrubar o build:
 *
 * 1. CI sem DATABASE_URL — nunca houve banco ali.
 * 2. Banco CONFIGURADO mas fora do ar, em build de PREVIEW. Foi o que
 *    aconteceu quando o projeto Supabase de desenvolvimento foi apagado
 *    (10/2026): o DATABASE_URL existia e apontava para um banco morto, a
 *    guarda do caso 1 não pegava, e TODO preview da Vercel passou a falhar —
 *    inclusive os de PRs que não tinham nada a ver com banco.
 *
 * Em PRODUÇÃO o erro sobe sempre: publicar uma loja vazia sem ninguém
 * perceber é pior do que um deploy que falha alto.
 *
 * E só erro de CONEXÃO vira fallback. Pergunta errada (coluna que não existe,
 * SQL inválido) continua derrubando o build em qualquer ambiente — é defeito
 * nosso, e esconder isso atrás de uma página vazia seria pior.
 */

/** Códigos de erro de conexão de postgres.js / Node. */
const CONNECTION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECTION_REFUSED",
]);

/**
 * O pooler do Supabase devolve um erro de BANCO (não de socket) quando o
 * projeto não existe mais: "Tenant or user not found". É inalcançável do
 * mesmo jeito.
 */
const UNREACHABLE_MESSAGES = [/tenant or user not found/i, /tenant\/user .* not found/i];

/** O banco não respondeu? (percorre a cadeia de causas) */
export function isDatabaseUnreachable(error: unknown): boolean {
  let atual: unknown = error;
  for (let profundidade = 0; profundidade < 6 && atual; profundidade += 1) {
    if (typeof atual !== "object") return false;
    const erro = atual as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof erro.code === "string" && CONNECTION_ERROR_CODES.has(erro.code)) return true;
    if (
      typeof erro.message === "string" &&
      UNREACHABLE_MESSAGES.some((padrao) => padrao.test(erro.message as string))
    ) {
      return true;
    }
    atual = erro.cause;
  }
  return false;
}

/** Build de produção na Vercel: ali o erro sobe, sempre. */
function isProductionBuild(): boolean {
  return process.env.VERCEL_ENV === "production";
}

export async function tryOrBuildFallback<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!process.env.DATABASE_URL) {
      console.warn("[build] Sem DATABASE_URL — usando fallback vazio para pré-renderização.");
      return fallback;
    }
    if (isDatabaseUnreachable(error) && !isProductionBuild()) {
      console.warn(
        "[build] Banco configurado mas fora do ar — usando fallback vazio nesta pré-renderização. Em produção isto seria um erro.",
      );
      return fallback;
    }
    throw error;
  }
}
