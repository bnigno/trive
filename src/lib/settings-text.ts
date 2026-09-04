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

/**
 * Frase de contato para as páginas legais, só com os canais preenchidos:
 * "pelo WhatsApp (x) ou pelo e-mail (y)" / um dos dois / "pelos nossos canais
 * de atendimento" quando nenhum foi cadastrado.
 */
export function describeContact(whatsapp: string, email: string): string {
  if (whatsapp && email) return `pelo WhatsApp (${whatsapp}) ou pelo e-mail (${email})`;
  if (whatsapp) return `pelo WhatsApp (${whatsapp})`;
  if (email) return `pelo e-mail (${email})`;
  return "pelos nossos canais de atendimento";
}
