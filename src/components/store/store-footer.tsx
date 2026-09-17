// Rodapé "créditos finais": noir em todas as páginas, com a marca completa
// (monograma escuro + wordmark + tagline), dados da loja (Decreto 7.962/2013),
// institucional e atendimento. Recebe os settings por props — o layout é o
// dono do getSettingsMap. Server Component.
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { Tagline } from "@/components/store/brand/tagline";
import { Wordmark } from "@/components/store/brand/wordmark";
import { LiaLink } from "@/components/store/lia-link";
import { NoirStage } from "@/components/store/noir-stage";
import { eyebrowNoir, hairlineNoir } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { STORE_TAGLINE } from "@/lib/brand";
import { waMeUrl } from "@/lib/phone";

const footerLink =
  "inline-flex min-h-11 items-center gap-2 text-sm text-ivory-200 transition-colors duration-300 hover:text-gold-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200";

export function StoreFooter({
  storeName,
  cnpj,
  address,
  email,
  whatsapp,
  instagram,
  sellerName,
}: {
  storeName: string;
  cnpj: string;
  address: string;
  email: string;
  whatsapp: string;
  /** Perfil do Instagram ('@usuario'); vazio = sem linha. */
  instagram: string;
  /** Nome da vendedora (setting bot_seller_name) para "Falar com a Lia". */
  sellerName: string;
}) {
  const hasStoreData = Boolean(cnpj || address || email || whatsapp);
  // Sem código (a ponte grava o dela ao tocar): é o link de emergência do botão.
  const whatsappUrl = waMeUrl(whatsapp, `Oi ${sellerName}, vim pelo site da ${storeName}`);

  return (
    <NoirStage
      as="footer"
      grain
      className={cx("site-footer mt-16 border-t", hairlineNoir)}
    >
      <div
        className="mx-auto max-w-6xl px-4 py-14 sm:px-6"
        style={{
          paddingLeft: "max(1rem, env(safe-area-inset-left))",
          paddingRight: "max(1rem, env(safe-area-inset-right))",
          paddingBottom: "max(3.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <Monogram tone="gold" size={56} lazy />
          <p>
            <Wordmark height={30} className="text-gold-brush">
              {storeName}
            </Wordmark>
          </p>
          <Tagline tone="noir" />
        </div>

        <div className="mt-12 grid gap-10 sm:grid-cols-3">
          <div className="space-y-1.5">
            <p className={`${eyebrowNoir} mb-3`}>A marca</p>
            <p className="font-display text-base font-semibold tracking-[0.2em] text-ivory-100">
              {storeName}
            </p>
            {hasStoreData ? (
              <div className="space-y-1 text-sm text-ivory-300">
                {cnpj ? <p>CNPJ: {cnpj}</p> : null}
                {address ? <p>{address}</p> : null}
                {email ? <p>{email}</p> : null}
                {whatsapp ? <p>WhatsApp: {whatsapp}</p> : null}
              </div>
            ) : (
              // Lembrete discreto para o dono da loja preencher os settings.
              <p className="text-xs text-ivory-400 italic">
                Dados da loja pendentes de configuração
              </p>
            )}
            {instagram ? (
              <p className="text-sm text-ivory-300">
                Instagram:{" "}
                <a href={`https://instagram.com/${instagram.replace(/^@/, "")}`} target="_blank" rel="noreferrer" className="underline decoration-ivory-500 underline-offset-4 hover:text-ivory-100">
                  {instagram}
                </a>
              </p>
            ) : null}
          </div>

          <nav aria-label="Institucional" className="flex flex-col">
            <p className={`${eyebrowNoir} mb-2`}>Institucional</p>
            <Link href="/termos" className={footerLink}>
              Termos de Uso
            </Link>
            <Link href="/privacidade" className={footerLink}>
              Política de Privacidade
            </Link>
            <Link href="/estilo" className={footerLink}>
              Sua cartela de estilo
            </Link>
            <Link href="/trocas-e-devolucoes" className={footerLink}>
              Trocas e Devoluções
            </Link>
          </nav>

          <div className="flex flex-col">
            <p className={`${eyebrowNoir} mb-2`}>Atendimento</p>
            <p className="min-h-11 py-2.5 text-sm text-ivory-300">
              Pagamento combinado via Pix
            </p>
            <p className="min-h-11 py-2.5 text-sm text-ivory-300">
              Envio para todo o Brasil
            </p>
            {whatsappUrl ? <LiaLink source="footer" sellerName={sellerName} fallbackUrl={whatsappUrl} variant="footer" /> : null}
          </div>
        </div>

        <p
          className={cx(
            "mt-12 border-t pt-6 text-center font-store text-xs tracking-[0.2em] text-ivory-400 uppercase",
            hairlineNoir,
          )}
        >
          © {new Date().getFullYear()} {storeName} · {STORE_TAGLINE} · Feito no
          Brasil
        </p>
      </div>
    </NoirStage>
  );
}
