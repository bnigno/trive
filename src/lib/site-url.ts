// Endereço público da loja — fonte ÚNICA. Usado para montar links absolutos
// que saem do sistema (e-mail, WhatsApp, retorno do Mercado Pago), onde um
// caminho relativo não funciona.
const DEFAULT_SITE_URL = "https://trivemaison.com.br";

/**
 * URL base do site, SEM barra final (para concatenar `${siteUrl()}/caminho`).
 * Sem NEXT_PUBLIC_SITE_URL configurado, cai no domínio de produção — nunca
 * em localhost, senão um e-mail enviado por engano leva o cliente a um link
 * morto.
 */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL).replace(
    /\/+$/,
    "",
  );
}
