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
import { OptionCard } from "@/components/store/order/option-card";
import { Sheet, SheetSection } from "@/components/store/order/sheet";
import { TotalsList } from "@/components/store/order/totals";
import { Ribbon } from "@/components/store/ribbon";
import {
  btnPrimary,
  btnSmallDark,
  eyebrow,
  inputBase,
  linkGold,
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { formatCentsBRL } from "@/lib/money";
import { formatCep } from "@/lib/cep";
import type { ShippingQuote } from "@/services/store-catalog";

import { quoteCouponAction, quoteShippingAction } from "./actions";
import { CartBar } from "./cart-bar";

type QuoteState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "done";
      cepDigits: string;
      quotes: ShippingQuote[];
      whatsappUrl: string | null;
    };

type CouponState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "applied"; code: string; discountCents: number };

const smallLink =
  "inline-flex min-h-11 items-center font-store text-xs text-ink-500 underline underline-offset-4 transition-colors hover:text-gold-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

export function CartView() {
  const { items, count, subtotalCents, setQuantity, removeItem } = useCart();

  // O carrinho hidrata em useEffect; até lá mostramos um esqueleto para não
  // piscar "sacola vazia" em quem tem itens salvos.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- marca pós-mount p/ hidratação SSR-safe do carrinho
  useEffect(() => setMounted(true), []);

  const [cepInput, setCepInput] = useState("");
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [selectedRateId, setSelectedRateId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // ----- Cupom de desconto -------------------------------------------------
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState<CouponState>({ status: "idle" });
  const [couponPending, startCouponTransition] = useTransition();

  const applyCoupon = useCallback(
    (code: string, lines: CartLine[]) => {
      startCouponTransition(async () => {
        const result = await quoteCouponAction({
          code,
          items: lines.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
          })),
        });
        if (!result.ok) {
          setCoupon({ status: "error", message: result.error });
          return;
        }
        setCoupon({
          status: "applied",
          code: result.code,
          discountCents: result.discountCents,
        });
      });
    },
    [startCouponTransition],
  );

  function handleCouponSubmit(event: React.FormEvent) {
    event.preventDefault();
    const code = couponInput.trim();
    if (!code || items.length === 0) return;
    applyCoupon(code, items);
  }

  function removeCoupon() {
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
          setSelectedRateId(null);
          return;
        }
        setQuote({
          status: "done",
          cepDigits,
          quotes: result.quotes,
          whatsappUrl: result.whatsappUrl,
        });
        // Mantém a escolha se ela continuar disponível; senão, pré-seleciona
        // a opção mais barata (a lista já vem ordenada por preço).
        setSelectedRateId((current) => {
          if (current && result.quotes.some((q) => q.rateId === current)) {
            return current;
          }
          return result.quotes[0]?.rateId ?? null;
        });
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
      setSelectedRateId(null);
      return;
    }
    runQuote(quote.cepDigits, items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, quote.status]);

  // Mudou a sacola com cupom aplicado? O subtotal mudou — re-cota o cupom
  // (o desconto percentual muda e o pedido mínimo pode deixar de valer).
  const lastCouponKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (coupon.status !== "applied") {
      lastCouponKeyRef.current = null;
      return;
    }
    if (lastCouponKeyRef.current === null) {
      lastCouponKeyRef.current = itemsKey;
      return;
    }
    if (lastCouponKeyRef.current === itemsKey) return;
    lastCouponKeyRef.current = itemsKey;
    if (items.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset do cupom quando a sacola esvazia (pós-hidratação)
      setCoupon({ status: "idle" });
      return;
    }
    applyCoupon(coupon.code, items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, coupon.status]);

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

  const selectedQuote =
    quote.status === "done"
      ? (quote.quotes.find((q) => q.rateId === selectedRateId) ?? null)
      : null;
  const appliedCoupon = coupon.status === "applied" ? coupon : null;
  const discountCents = appliedCoupon?.discountCents ?? 0;
  const totalCents =
    subtotalCents - discountCents + (selectedQuote?.priceCents ?? 0);
  const checkoutHref =
    quote.status === "done" && selectedQuote
      ? `/checkout?cep=${quote.cepDigits}&frete=${selectedQuote.rateId}${
          appliedCoupon ? `&cupom=${encodeURIComponent(appliedCoupon.code)}` : ""
        }`
      : null;
  const noDelivery = quote.status === "done" && quote.quotes.length === 0;

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

              {noDelivery ? (
                <Notice tone="gold" role="alert" className="mt-2">
                  Ainda não entregamos para este CEP —{" "}
                  {quote.status === "done" && quote.whatsappUrl ? (
                    <a
                      href={quote.whatsappUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkGold}
                    >
                      fale com a gente no WhatsApp
                    </a>
                  ) : (
                    "fale com a gente no WhatsApp"
                  )}
                  .
                </Notice>
              ) : null}

              {quote.status === "done" && quote.quotes.length > 0 ? (
                <fieldset className="mt-3">
                  <legend className="sr-only">Opções de entrega</legend>
                  <div className="space-y-2">
                    {quote.quotes.map((option) => (
                      <OptionCard
                        key={option.rateId}
                        name="shippingRate"
                        value={option.rateId}
                        checked={selectedRateId === option.rateId}
                        onChange={() => setSelectedRateId(option.rateId)}
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
                </fieldset>
              ) : null}
            </SheetSection>

            <SheetSection title="Cupom">
              {appliedCoupon ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="font-store text-sm font-medium text-laurel-700">
                    {appliedCoupon.code} aplicado
                  </span>
                  <button
                    type="button"
                    onClick={removeCoupon}
                    className={cx(smallLink, "hover:text-claret-700")}
                  >
                    remover cupom
                  </button>
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
                shippingCents={selectedQuote ? selectedQuote.priceCents : null}
                shippingFallback="calcule acima"
                totalCents={totalCents}
              />
              <CheckoutCta href={checkoutHref} className="mt-5" />
            </SheetSection>
          </div>
        </Sheet>
      </div>

      <CartBar
        visible={barVisible}
        totalCents={totalCents}
        href={checkoutHref}
        noDelivery={noDelivery}
        whatsappUrl={quote.status === "done" ? quote.whatsappUrl : null}
      />
    </div>
  );
}
