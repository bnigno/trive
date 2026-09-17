// Identidade textual da maison. Fonte única do nome usado como fallback quando
// settings.store_name está vazio — services, componentes e páginas importam daqui
// em vez de repetir a string (a grafia oficial é TRIVÉ, com acento agudo).
export const STORE_NAME_DEFAULT = "TRIVÉ";

/** Tagline oficial, sempre em francês e caixa alta na exibição. */
export const STORE_TAGLINE = "Maison Féminine";

/** A frase do hero da vitrine (fallback de settings.store_tagline) — a voz da marca, reutilizada no adesivo da sacola. */
export const STORE_HERO_LINE_DEFAULT = "Para a mulher que se veste de si.";

/** Perfil do Instagram da loja (fallback de settings.store_instagram), sempre com o "@". */
export const STORE_INSTAGRAM_DEFAULT = "@trive_mfeminine";

/** '@Loja', 'loja', 'instagram.com/loja/' → '@loja'; vazio → ''. Sem validar além do formato de usuário do Instagram. */
export function normalizeInstagramHandle(raw: string): string | null {
  const value = raw.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "").replace(/^@/, "").toLowerCase();
  if (value === "") return "";
  return /^[a-z0-9._]{1,30}$/.test(value) ? `@${value}` : null;
}

/**
 * Chave de sessionStorage que marca "o véu de abertura já foi visto nesta
 * aba". Lida por um <script> inline na home (antes do primeiro paint) e pelo
 * componente do véu — vive aqui porque um módulo "use client" não pode
 * exportar constantes para Server Components.
 */
export const VEIL_SEEN_KEY = "trive-veil-seen";
