"use client";

// Sacola completa: peças, calculadora de entrega por CEP, cupom e o resumo
// (a folha), com a barra fixa no celular. Mobile-first: coluna única; em
// telas largas o resumo vai para a lateral e fica grudado. A lógica de
// estado (carrinho, cotação, cupom, re-cotação) é a mesma da versão
// anterior; só a apresentação mudou.

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { CartLineItem } from "@/components/store/cart/cart-line-item";
import { CartSkeleton } from "@/components/store/cart/cart-skeleton";
import { useCart, type CartLine } from "@/components/store/cart/cart-context";
import { CheckoutCta } from "@/components/store/cart/checkout-cta";
import { EmptyState } from "@/components/store/empty-state";
import { deliveryLabel } from "@/components/store/order/delivery-label";
import { Notice } from "@/components/store/order/notice";
import { CorreiosOnRequestNotice } from "@/components/store/order/correios-on-request";
import { OptionCard } from "@/components/store/order/option-card";
import { Sheet, SheetSection } from "@/components/store/order/sheet";
import { TotalsList } from "@/components/store/order/totals";
import { Ribbon } from "@/components/store/ribbon";
import {
  btnPrimary,
  btnSmallDark,
  eyebrow,
  inputBase,
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { LiaLink } from "@/components/store/lia-link";
import { formatCentsBRL } from "@/lib/money";
import { formatCep } from "@/lib/cep";
import { writeStoredCep } from "@/lib/cep-storage";
import type { DeliveryOption } from "@/core/shipping/delivery-windows";
import { pickDefaultOptionKey } from "@/lib/checkout-options";

import { readStoredCoupon, takeLinkCoupon, writeStoredCoupon } from "@/lib/coupon-storage";

import { quoteCouponAction, quoteShippingAction } from "./actions";
import { CartBar } from "./cart-bar";

type QuoteState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "done";
      cepDigits: string;
      options: DeliveryOption[];
      whatsappUrl: string | null;
      sellerName: string;
      motoboyArea: string;
    };

type CouponState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "applied";
      code: string;
      discountCents: number;
      freeShipping: boolean;
      /** Frete perdoado com a entrega escolhida (0 sem entrega). */
      shippingDiscountCents: number;
      /** "Confirmamos no fechamento…" — o que depende de CPF/telefone/entrega. */
      pendingNotice: string | null;
      /** Cupom que muda com o tempo: o que vale hoje e quando muda. */
      hint: string | null;
    };

/** Cupom que não existe mais não fica guardado no navegador (os outros erros são da sacola de agora). */
const FORGET_STORED_ON = new Set(["COUPON_NOT_FOUND", "COUPON_INACTIVE", "COUPON_EXPIRED", "COUPON_EXHAUSTED"]);

/** A entrega escolhida como o cupom precisa dela (valor + tipo), ou null. */
function shippingForCoupon(option: DeliveryOption | null): { cents: number; kind: "motoboy" | "correios" } | null {
  return option ? { cents: option.priceCents, kind: option.kind } : null;
}

const smallLink =
  "inline-flex min-h-11 items-center font-store text-xs text-ink-500 underline underline-offset-4 transition-colors hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

export function CartView({ lia }: { lia?: { sellerName: string; fallbackUrl: string | null } | null }) {
  const { items, count, subtotalCents, setQuantity, removeItem } = useCart();

  // O carrinho hidrata em useEffect; até lá mostramos um esqueleto para não
  // piscar "sacola vazia" em quem tem itens salvos.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- marca pós-mount p/ hidratação SSR-safe do carrinho
  useEffect(() => setMounted(true), []);

  const [cepInput, setCepInput] = useState("");
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // ----- Cupom de desconto -------------------------------------------------
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<CouponState>({ status: "idle" });
  const [couponPending, startCouponTransition] = useTransition();

  const applyCoupon = useCallback(
    (code: string, lines: CartLine[], shipping: { cents: number; kind: "motoboy" | "correios" } | null) => {
      startCouponTransition(async () => {
        const result = await quoteCouponAction({
          code,
          items: lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
          shipping,
        });
        if (!result.ok) {
          if (result.errorCode && FORGET_STORED_ON.has(result.errorCode)) writeStoredCoupon(null);
          setCoupon({ status: "error", message: result.error });
          return;
        }
        // Guardado no navegador: o checkout e a próxima visita já sabem o cupom.
        writeStoredCoupon(result.code);
        setCoupon({
          status: "applied",
          code: result.code,
          discountCents: result.discountCents,
          freeShipping: result.freeShipping,
          shippingDiscountCents: result.shippingDiscountCents,
          pendingNotice: result.pendingNotice,
          hint: result.hint,
        });
      });
    },
    [startCouponTransition],
  );

  // Cupom que chegou pelo link /c/CÓDIGO (tentado uma vez) ou aplicado numa
  // visita anterior: entra sozinho assim que a sacola hidrata com peças.
  const storedTriedRef = useRef(false);
  useEffect(() => {
    if (!mounted || storedTriedRef.current || items.length === 0) return;
    storedTriedRef.current = true;
    const stored = takeLinkCoupon() ?? readStoredCoupon();
    if (!stored || coupon.status !== "idle") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- preenche o campo com o código guardado (pós-hidratação)
    setCouponInput(stored);
    applyCoupon(stored, items, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, items.length]);

  function handleCouponSubmit(event: React.FormEvent) {
    event.preventDefault();
    const code = couponInput.trim();
    if (!code || items.length === 0) return;
    applyCoupon(code, items, shippingForCoupon(selectedQuote));
  }

  function removeCoupon() {
    writeStoredCoupon(null);
    setCoupon({ status: "idle" });
    setCouponInput("");
  }

  const runQuote = useCallback(
    (cepDigits: string, lines: CartLine[]) => {
      startTransition(async () => {
        const result = await quoteShippingAction({
          cep: cepDigits,
          items: lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
        });
        if (!result.ok) {
          setQuote({ status: "error", message: result.error });
          setSelectedOptionKey(null);
          return;
        }
        setQuote({
          status: "done",
          cepDigits,
          options: result.options,
          whatsappUrl: result.whatsappUrl,
          sellerName: result.sellerName,
          motoboyArea: result.motoboyArea,
        });
        // A página da peça usa este CEP para prometer "chega hoje".
        writeStoredCep(cepDigits);
        // Mantém a escolha se ela continuar disponível; senão, pré-seleciona
        // a primeira (motoboy de hoje, depois a mais barata).
        setSelectedOptionKey((current) => pickDefaultOptionKey(result.options, current));
      });
    },
    [startTransition],
  );

  function handleQuoteSubmit(event: React.FormEvent) {
    event.preventDefault();
    const cepDigits = cepInput.replace(/\D/g, "");
    if (cepDigits.length !== 8) {
      setQuote({
        status: "error",
        message: "CEP inválido. Informe um CEP com 8 dígitos.",
      });
      return;
    }
    if (items.length === 0) return;
    runQuote(cepDigits, items);
  }

  // Mudou quantidade/itens depois de uma cotação? O peso mudou — recota
  // automaticamente para o mesmo CEP.
  const itemsKey = items
    .map((line) => `${line.variantId}:${line.quantity}`)
    .join(",");
  const lastQuotedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (quote.status !== "done") {
      lastQuotedKeyRef.current = null;
      return;
    }
    if (lastQuotedKeyRef.current === null) {
      lastQuotedKeyRef.current = itemsKey;
      return;
    }
    if (lastQuotedKeyRef.current === itemsKey) return;
    lastQuotedKeyRef.current = itemsKey;
    if (items.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset da cotação quando a sacola esvazia (pós-hidratação)
      setQuote({ status: "idle" });
      setSelectedOptionKey(null);
      return;
    }
    runQuote(quote.cepDigits, items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, quote.status]);

  const selectedQuote =
    quote.status === "done"
      ? (quote.options.find((o) => o.optionKey === selectedOptionKey) ?? null)
      : null;

  // Mudou a sacola com cupom aplicado? O subtotal mudou — re-cota o cupom
  // (o desconto percentual muda e o pedido mínimo pode deixar de valer).
  // Cupom de frete grátis também acompanha a entrega escolhida (o valor
  // perdoado e o escopo motoboy/Correios dependem dela).
  const couponKey =
    coupon.status === "applied" && coupon.freeShipping
      ? `${itemsKey}|${selectedQuote?.optionKey ?? ""}`
      : itemsKey;
  const lastCouponKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (coupon.status !== "applied") {
      lastCouponKeyRef.current = null;
      return;
    }
    if (lastCouponKeyRef.current === null) {
      lastCouponKeyRef.current = couponKey;
      return;
    }
    if (lastCouponKeyRef.current === couponKey) return;
    lastCouponKeyRef.current = couponKey;
    if (items.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset do cupom quando a sacola esvazia (pós-hidratação)
      setCoupon({ status: "idle" });
      return;
    }
    applyCoupon(coupon.code, items, shippingForCoupon(selectedQuote));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponKey, coupon.status]);

  // Barra fixa do celular: visível sempre que a folha do resumo está fora da
  // tela (acima ou abaixo). O setState acontece só no callback do observer.
  const hasItems = items.length > 0;
  const summaryRef = useRef<HTMLElement>(null);
  const [barVisible, setBarVisible] = useState(false);
  useEffect(() => {
    const summary = summaryRef.current;
    if (!mounted || !hasItems || !summary) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setBarVisible(!entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(summary);
    return () => observer.disconnect();
  }, [mounted, hasItems]);

  const appliedCoupon = coupon.status === "applied" ? coupon : null;
  const discountCents = appliedCoupon?.discountCents ?? 0;
  // Frete cobrado = preço da opção − o que o cupom de frete grátis perdoa.
  const shippingDiscountCents = selectedQuote ? Math.min(appliedCoupon?.shippingDiscountCents ?? 0, selectedQuote.priceCents) : 0;
  const chargedShippingCents = selectedQuote ? selectedQuote.priceCents - shippingDiscountCents : null;
  const totalCents = subtotalCents - discountCents + (chargedShippingCents ?? 0);
  const checkoutHref =
    quote.status === "done" && selectedQuote
      ? `/checkout?cep=${quote.cepDigits}&frete=${encodeURIComponent(selectedQuote.optionKey)}${
          appliedCoupon ? `&cupom=${encodeURIComponent(appliedCoupon.code)}` : ""
        }`
      : null;
  const noDelivery = quote.status === "done" && quote.options.length === 0;

  if (!mounted) {
    return <CartSkeleton />;
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <header className="mb-8 flex flex-col items-start gap-2">
          <p className={eyebrow}>Sacola</p>
          <h1 className="font-display text-title font-semibold text-espresso-900">
            Sua sacola
          </h1>
          <Ribbon variant="static" size="sm" className="mt-1" />
        </header>
        <EmptyState
          title="Sua sacola ainda está vazia"
          hint="A coleção está aberta. Escolha o que for seu."
          action={
            <Link href="/produtos" className={btnPrimary}>
              Ver a coleção
            </Link>
          }
        />
      </div>
    );
  }

  return (
    // pb-24 reserva o espaço da barra fixa no celular.
    <div className="mx-auto w-full max-w-6xl px-4 py-8 pb-24 sm:px-6 lg:pb-8">
      <header className="flex flex-col items-start gap-2">
        <p className={eyebrow}>
          Sacola · {count} {count === 1 ? "peça" : "peças"}
        </p>
        <h1 className="font-display text-title font-semibold text-espresso-900">
          Sua sacola
        </h1>
        <Ribbon variant="static" size="sm" className="mt-1" />
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-16">
        <div>
          <ul className="divide-y divide-ivory-300 border-y border-ivory-300">
            {items.map((line) => (
              <CartLineItem
                key={line.variantId}
                line={line}
                onRemove={() => removeItem(line.variantId)}
                onQuantity={(quantity) => setQuantity(line.variantId, quantity)}
              />
            ))}
          </ul>
          <Link
            href="/produtos"
            className="mt-4 inline-flex min-h-11 items-center font-store text-xs tracking-[0.16em] text-ink-700 uppercase underline decoration-gold-500 underline-offset-4 transition-colors hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
          >
            Continuar escolhendo
          </Link>
        </div>

        {/* A folha do resumo */}
        <Sheet
          ref={summaryRef}
          eyebrow="Resumo"
          headingId="resumo-title"
          aria-labelledby="resumo-title"
          ornament
          sticky
        >
          <div className="mt-5">
            <SheetSection title="Entrega" headingId="frete-title">
              <form onSubmit={handleQuoteSubmit} className="flex items-end gap-3">
                <label htmlFor="cart-cep" className="sr-only">
                  CEP de entrega
                </label>
                <input
                  id="cart-cep"
                  name="cep"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="00000-000"
                  value={cepInput}
                  onChange={(event) => setCepInput(formatCep(event.target.value))}
                  className={cx(inputBase, "min-w-0")}
                />
                <button type="submit" disabled={pending} className={btnSmallDark}>
                  {pending ? "Calculando…" : "Calcular"}
                </button>
              </form>
              <a
                href="https://buscacepinter.correios.com.br/app/endereco/index.php"
                target="_blank"
                rel="noopener noreferrer"
                className={smallLink}
              >
                Não sei meu CEP
              </a>

              {quote.status === "error" ? (
                <Notice tone="claret" role="alert" className="mt-2">
                  {quote.message}
                </Notice>
              ) : null}

              {noDelivery && quote.status === "done" ? (
                <CorreiosOnRequestNotice
                  className="mt-2"
                  cepDigits={quote.cepDigits}
                  motoboyArea={quote.motoboyArea}
                  sellerName={quote.sellerName}
                  fallbackUrl={quote.whatsappUrl}
                  items={items.map((line) => ({ variantId: line.variantId, sku: line.sku, quantity: line.quantity }))}
                />
              ) : null}

              {quote.status === "done" && quote.options.length > 0 ? (
                <fieldset className="mt-3">
                  <legend className="sr-only">Opções de entrega</legend>
                  <div className="space-y-2">
                    {quote.options.map((option) => (
                      <OptionCard
                        key={option.optionKey}
                        name="shippingRate"
                        value={option.optionKey}
                        checked={selectedOptionKey === option.optionKey}
                        onChange={() => setSelectedOptionKey(option.optionKey)}
                        title={option.name}
                        detail={deliveryLabel(option)}
                        trailing={
                          option.priceCents === 0 ? (
                            <span className="text-laurel-700">Grátis</span>
                          ) : (
                            formatCentsBRL(option.priceCents)
                          )
                        }
                      />
                    ))}
                  </div>
                  {quote.options.some((option) => option.kind === "correios") ? (
                    <p className="mt-2 font-store text-xs text-ink-500">Correios: prazo em dias úteis, contado a partir da postagem.</p>
                  ) : null}
                </fieldset>
              ) : null}
            </SheetSection>

            <SheetSection title="Cupom">
              {appliedCoupon ? (
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-store text-sm font-medium text-laurel-700">
                      {appliedCoupon.code} aplicado
                      {appliedCoupon.freeShipping ? " · frete grátis" : ""}
                    </span>
                    <button
                      type="button"
                      onClick={removeCoupon}
                      className={cx(smallLink, "hover:text-claret-700")}
                    >
                      remover cupom
                    </button>
                  </div>
                  {appliedCoupon.hint ? (
                    <p className="mt-1 font-store text-xs text-gold-800">{appliedCoupon.hint}</p>
                  ) : null}
                  {appliedCoupon.pendingNotice ? (
                    <p className="mt-1 font-store text-xs text-ink-500">{appliedCoupon.pendingNotice}</p>
                  ) : null}
                </div>
              ) : (
                <form onSubmit={handleCouponSubmit} className="flex items-end gap-3">
                  <label htmlFor="cart-coupon" className="sr-only">
                    Código do cupom
                  </label>
                  <input
                    id="cart-coupon"
                    name="coupon"
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="Ex.: BEMVINDA10"
                    value={couponInput}
                    onChange={(event) =>
                      setCouponInput(event.target.value.toUpperCase())
                    }
                    className={cx(inputBase, "min-w-0 uppercase placeholder:normal-case")}
                  />
                  <button
                    type="submit"
                    disabled={couponPending || couponInput.trim() === ""}
                    className={btnSmallDark}
                  >
                    {couponPending ? "Aplicando…" : "Aplicar"}
                  </button>
                </form>
              )}
              {coupon.status === "error" ? (
                <Notice tone="claret" role="alert" className="mt-2">
                  {coupon.message}
                </Notice>
              ) : null}
            </SheetSection>

            <SheetSection title="Totais">
              <TotalsList
                subtotalCents={subtotalCents}
                discountCents={discountCents}
                discountLabel={
                  appliedCoupon ? `Desconto (${appliedCoupon.code})` : "Desconto"
                }
                shippingCents={chargedShippingCents}
                shippingFallback="calcule acima"
                shippingNote={shippingDiscountCents > 0 ? "Frete grátis pelo cupom" : undefined}
                totalCents={totalCents}
              />
              <CheckoutCta href={checkoutHref} className="mt-5" />
              {lia?.fallbackUrl ? (
                <div className="mt-4 flex flex-col gap-1">
                  <LiaLink
                    source="cart"
                    sellerName={lia.sellerName}
                    fallbackUrl={lia.fallbackUrl}
                    items={items.map((line) => ({ variantId: line.variantId, sku: line.sku, quantity: line.quantity }))}
                    cep={quote.status === "done" ? quote.cepDigits : undefined}
                    className="w-full"
                  />
                  <p className="font-store text-[13px] text-ink-500">Prefere fechar pelo WhatsApp? A {lia.sellerName} recebe a sua sacola como está.</p>
                </div>
              ) : null}
            </SheetSection>
          </div>
        </Sheet>
      </div>

      <CartBar
        visible={barVisible}
        totalCents={totalCents}
        href={checkoutHref}
        noDelivery={noDelivery}
        lia={
          quote.status === "done"
            ? { sellerName: quote.sellerName, fallbackUrl: quote.whatsappUrl, cepDigits: quote.cepDigits, items: items.map((line) => ({ variantId: line.variantId, sku: line.sku, quantity: line.quantity })) }
            : null
        }
      />
    </div>
  );
}
