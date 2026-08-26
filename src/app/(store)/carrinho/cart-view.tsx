"use client";

// Sacola completa: itens, calculadora de frete por CEP e resumo.
// Mobile-first: coluna única; em telas largas o resumo vai para a lateral.

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { useCart, type CartLine } from "@/components/store/cart/cart-context";
import { EmptyState } from "@/components/store/empty-state";
import { btnPrimary, eyebrow, inputBase } from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { Money } from "@/components/ui/money";
import type { ShippingQuote } from "@/services/store-catalog";

import { quoteCouponAction, quoteShippingAction } from "./actions";

/** Máscara 00000-000 conforme o usuário digita. */
function formatCep(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function deliveryLabel(quote: ShippingQuote): string {
  const { deliveryDaysMin: min, deliveryDaysMax: max } = quote;
  if (min === max) return min === 1 ? "1 dia útil" : `${min} dias úteis`;
  return `${min}–${max} dias úteis`;
}

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

  if (!mounted) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <div
          aria-busy="true"
          aria-label="Carregando sua sacola"
          className="animate-pulse space-y-4"
        >
          <div className="h-8 w-40 rounded-(--radius-hair) bg-ivory-200/80" />
          <div className="h-28 rounded-(--radius-hair) bg-ivory-200/80" />
          <div className="h-28 rounded-(--radius-hair) bg-ivory-200/80" />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="mb-6 font-display text-title text-ink-900">
          Sua sacola
        </h1>
        <EmptyState
          title="Sua sacola está vazia"
          hint="Explore a loja e adicione o que você amar."
          action={
            <Link href="/produtos" className={btnPrimary}>
              Ver produtos
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 font-display text-title text-ink-900">
        Sua sacola{" "}
        <span className="font-store text-base text-ink-500">
          ({count} {count === 1 ? "item" : "itens"})
        </span>
      </h1>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
        {/* Itens: linhas hairline (sem cards) */}
        <ul className="divide-y divide-ivory-300 border-y border-ivory-300">
          {items.map((line) => (
            <li key={line.variantId} className="flex gap-4 py-5">
              {/* <img> simples com lazy: o otimizador de imagens da Vercel tem
                  limites no plano gratuito — evitamos next/image de propósito. */}
              {line.imageUrl ? (
                <img
                  src={line.imageUrl}
                  alt={line.name}
                  loading="lazy"
                  width={96}
                  height={96}
                  className="h-24 w-24 shrink-0 rounded-(--radius-soft) object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-24 w-24 shrink-0 items-center justify-center rounded-(--radius-soft) bg-ivory-200 text-ink-300"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="h-8 w-8"
                  >
                    <path d="M6 8h12l1 12a1.6 1.6 0 0 1-1.6 1.7H6.6A1.6 1.6 0 0 1 5 20L6 8Z" />
                    <path d="M9 10V6a3 3 0 0 1 6 0v4" />
                  </svg>
                </div>
              )}

              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/produto/${line.slug}`}
                      className="line-clamp-2 text-sm font-medium text-ink-900 transition-colors hover:text-gold-800"
                    >
                      {line.name}
                    </Link>
                    {line.attributesLabel ? (
                      <p className="mt-0.5 text-xs text-ink-500">
                        {line.attributesLabel}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(line.variantId)}
                    aria-label={`Remover ${line.name} da sacola`}
                    className="shrink-0 p-1 text-ink-400 transition-colors hover:text-claret-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="h-5 w-5"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                  {/* Stepper de quantidade, limitado ao estoque disponível */}
                  <div className="flex items-center gap-1 rounded-(--radius-hair) border border-ivory-400">
                    <button
                      type="button"
                      onClick={() => setQuantity(line.variantId, line.quantity - 1)}
                      aria-label={`Diminuir quantidade de ${line.name}`}
                      className="flex h-8 w-8 items-center justify-center rounded-(--radius-hair) text-ink-700 transition-colors hover:bg-ivory-200 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                    >
                      −
                    </button>
                    <span
                      aria-label={`Quantidade: ${line.quantity}`}
                      className="min-w-6 text-center text-sm font-medium text-ink-900 tabular-nums"
                    >
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuantity(line.variantId, line.quantity + 1)}
                      disabled={line.quantity >= line.availableQty}
                      aria-label={`Aumentar quantidade de ${line.name}`}
                      className="flex h-8 w-8 items-center justify-center rounded-(--radius-hair) text-ink-700 transition-colors hover:bg-ivory-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                    >
                      +
                    </button>
                  </div>

                  <div className="text-right">
                    <Money
                      cents={line.priceCents * line.quantity}
                      className="text-base font-medium text-ink-900"
                    />
                    {line.quantity > 1 ? (
                      <p className="text-xs text-ink-500">
                        <Money cents={line.priceCents} /> cada
                      </p>
                    ) : null}
                  </div>
                </div>

                {line.quantity >= line.availableQty ? (
                  <p className="text-xs text-ink-500">
                    Só {line.availableQty} em estoque.
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        {/* Frete + resumo */}
        <div className="space-y-4 lg:sticky lg:top-24">
          <section
            aria-labelledby="frete-title"
            className="rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 p-5"
          >
            <h2 id="frete-title" className={eyebrow}>
              Calcular frete e prazo
            </h2>
            <form onSubmit={handleQuoteSubmit} className="mt-3 flex items-end gap-3">
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
              <button
                type="submit"
                disabled={pending}
                className="shrink-0 rounded-(--radius-hair) bg-ink-950 px-4 py-2 font-store text-xs font-medium uppercase tracking-[0.14em] text-ivory-50 transition-colors duration-300 ease-silk hover:bg-ink-800 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
              >
                {pending ? "Calculando…" : "Calcular"}
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-500">
              <a
                href="https://buscacepinter.correios.com.br/app/endereco/index.php"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-gold-800"
              >
                Não sei meu CEP
              </a>
            </p>

            {quote.status === "error" ? (
              <p
                role="alert"
                className="mt-3 rounded-(--radius-hair) border border-claret-600/30 bg-claret-50 px-3 py-2 text-sm text-claret-700"
              >
                {quote.message}
              </p>
            ) : null}

            {quote.status === "done" && quote.quotes.length === 0 ? (
              <div
                role="alert"
                className="mt-3 rounded-(--radius-hair) border border-gold-600/40 bg-gold-500/8 px-3 py-2 text-sm text-ink-900"
              >
                Ainda não entregamos para este CEP —{" "}
                {quote.whatsappUrl ? (
                  <a
                    href={quote.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold underline"
                  >
                    fale conosco no WhatsApp
                  </a>
                ) : (
                  "fale conosco no WhatsApp"
                )}
                .
              </div>
            ) : null}

            {quote.status === "done" && quote.quotes.length > 0 ? (
              <fieldset className="mt-3">
                <legend className="sr-only">Opções de entrega</legend>
                <div className="space-y-2">
                  {quote.quotes.map((option) => (
                    <label
                      key={option.rateId}
                      className={[
                        "flex cursor-pointer items-center gap-3 rounded-(--radius-hair) border px-3 py-2.5 transition-colors",
                        selectedRateId === option.rateId
                          ? "border-gold-600 bg-gold-500/8"
                          : "border-ivory-300 hover:border-ivory-400",
                      ].join(" ")}
                    >
                      <input
                        type="radio"
                        name="shippingRate"
                        value={option.rateId}
                        checked={selectedRateId === option.rateId}
                        onChange={() => setSelectedRateId(option.rateId)}
                        className="h-4 w-4 accent-gold-600"
                      />
                      <span className="flex flex-1 items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0">
                          <span className="font-medium text-ink-900">
                            {option.name}
                          </span>{" "}
                          <span className="text-xs text-ink-500">
                            {deliveryLabel(option)}
                          </span>
                        </span>
                        {option.priceCents === 0 ? (
                          <span className="font-medium text-laurel-700">
                            Grátis
                          </span>
                        ) : (
                          <Money
                            cents={option.priceCents}
                            className="font-medium text-ink-900"
                          />
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </section>

          <section
            aria-label="Resumo do pedido"
            className="rounded-(--radius-hair) border border-ivory-300 bg-ivory-50 p-5"
          >
            {/* Cupom de desconto */}
            <div className="mb-4 border-b border-ivory-300 pb-4">
              <h2 className={eyebrow}>Cupom de desconto</h2>
              {appliedCoupon ? (
                <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-laurel-700">
                    {appliedCoupon.code} aplicado
                  </span>
                  <button
                    type="button"
                    onClick={removeCoupon}
                    className="text-xs text-ink-500 underline transition-colors hover:text-claret-600"
                  >
                    remover cupom
                  </button>
                </div>
              ) : (
                <form onSubmit={handleCouponSubmit} className="mt-2 flex items-end gap-3">
                  <label htmlFor="cart-coupon" className="sr-only">
                    Código do cupom
                  </label>
                  <input
                    id="cart-coupon"
                    name="coupon"
                    autoComplete="off"
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
                    className="shrink-0 rounded-(--radius-hair) bg-ink-950 px-4 py-2 font-store text-xs font-medium uppercase tracking-[0.14em] text-ivory-50 transition-colors duration-300 ease-silk hover:bg-ink-800 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600"
                  >
                    {couponPending ? "Aplicando…" : "Aplicar"}
                  </button>
                </form>
              )}
              {coupon.status === "error" ? (
                <p
                  role="alert"
                  className="mt-2 rounded-(--radius-hair) border border-claret-600/30 bg-claret-50 px-3 py-2 text-sm text-claret-700"
                >
                  {coupon.message}
                </p>
              ) : null}
            </div>

            <dl className="space-y-2 text-sm">
              <div className="flex justify-between text-ink-700">
                <dt>Subtotal</dt>
                <dd>
                  <Money cents={subtotalCents} />
                </dd>
              </div>
              {appliedCoupon ? (
                <div className="flex justify-between font-medium text-laurel-700">
                  <dt>Desconto</dt>
                  <dd>
                    − <Money cents={appliedCoupon.discountCents} /> (
                    {appliedCoupon.code})
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between text-ink-700">
                <dt>Frete</dt>
                <dd>
                  {selectedQuote ? (
                    selectedQuote.priceCents === 0 ? (
                      <span className="font-medium text-laurel-700">
                        Grátis
                      </span>
                    ) : (
                      <Money cents={selectedQuote.priceCents} />
                    )
                  ) : (
                    <span className="text-ink-400">calcule acima</span>
                  )}
                </dd>
              </div>
              <div className="flex justify-between border-t border-ivory-300 pt-3 text-base font-semibold text-ink-900">
                <dt>Total</dt>
                <dd>
                  <Money cents={totalCents} className="text-ink-900" />
                </dd>
              </div>
            </dl>

            {checkoutHref ? (
              <Link href={checkoutHref} className={cx(btnPrimary, "mt-5 w-full")}>
                Fechar pedido
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  disabled
                  className="mt-5 inline-flex w-full cursor-not-allowed items-center justify-center rounded-(--radius-hair) bg-ivory-200 px-7 py-3.5 font-store text-sm font-medium uppercase tracking-[0.16em] text-ink-400"
                >
                  Fechar pedido
                </button>
                <p className="mt-2 text-center text-xs text-ink-500">
                  Calcule o frete para continuar.
                </p>
              </>
            )}

            <Link
              href="/produtos"
              className="mt-4 block text-center text-sm text-ink-700 underline underline-offset-4 transition-colors hover:text-gold-800"
            >
              Continuar comprando
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
