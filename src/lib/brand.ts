// Identidade textual da maison. Fonte única do nome usado como fallback quando
// settings.store_name está vazio — services, componentes e páginas importam daqui
// em vez de repetir a string (a grafia oficial é TRIVÉ, com acento agudo).
export const STORE_NAME_DEFAULT = "TRIVÉ";

/** Tagline oficial, sempre em francês e caixa alta na exibição. */
export const STORE_TAGLINE = "Maison Féminine";

/**
 * Chave de sessionStorage que marca "o véu de abertura já foi visto nesta
 * aba". Lida por um <script> inline na home (antes do primeiro paint) e pelo
 * componente do véu — vive aqui porque um módulo "use client" não pode
 * exportar constantes para Server Components.
 */
export const VEIL_SEEN_KEY = "trive-veil-seen";
