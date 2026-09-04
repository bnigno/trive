// Lê um texto do mapa de configurações (getSettingsMap) com fallback: as
// páginas legais e os rodapés montam frases só quando o dono preencheu o dado.
export function settingText(
  map: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = map[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
