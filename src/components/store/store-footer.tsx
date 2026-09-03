// Rodapé "créditos finais": noir em todas as páginas, com a marca completa
// (monograma escuro + wordmark + tagline), dados da loja (Decreto 7.962/2013),
// institucional e atendimento. Recebe os settings por props — o layout é o
// dono do getSettingsMap. Server Component.
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { Tagline } from "@/components/store/brand/tagline";
import { Wordmark } from "@/components/store/brand/wordmark";
import { IconWhatsApp } from "@/components/store/icons";
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
}: {
  storeName: string;
  cnpj: string;
  address: string;
  email: string;
  whatsapp: string;
}) {
  const hasStoreData = Boolean(cnpj || address || email || whatsapp);
  const whatsappUrl = waMeUrl(whatsapp, `Olá! Vim pelo site da ${storeName}`);

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
            <Wordmark className="text-3xl text-gold-brush">{storeName}</Wordmark>
          </p>
          <Tagline tone="noir" />
        </div>

        <div className="mt-12 grid gap-10 sm:grid-cols-3">
          <div className="space-y-1.5">
            <p className={`${eyebrowNoir} mb-3`}>A maison</p>
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
          </div>

          <nav aria-label="Institucional" className="flex flex-col">
            <p className={`${eyebrowNoir} mb-2`}>Institucional</p>
            <Link href="/termos" className={footerLink}>
              Termos de Uso
            </Link>
            <Link href="/privacidade" className={footerLink}>
              Política de Privacidade
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
            {whatsappUrl ? (
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={footerLink}
              >
                <IconWhatsApp className="h-5 w-5" />
                Falar com a maison
              </a>
            ) : null}
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
