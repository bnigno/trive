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
import { EmptyState } from "@/components/ui/empty-state";
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
          <div className="h-8 w-40 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-28 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-28 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Sua sacola
        </h1>
        <EmptyState
          title="Sua sacola está vazia"
          hint="Explore a loja e adicione o que você amar."
          action={
            <Link
              href="/produtos"
              className="inline-flex items-center justify-center rounded-full bg-amber-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-800"
            >
              Ver produtos
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        Sua sacola{" "}
        <span className="text-base font-normal text-zinc-500 dark:text-zinc-400">
          ({count} {count === 1 ? "item" : "itens"})
        </span>
      </h1>

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:items-start">
        {/* Itens */}
        <ul className="space-y-3">
          {items.map((line) => (
            <li
              key={line.variantId}
              className="flex gap-4 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              {/* <img> simples com lazy: o otimizador de imagens da Vercel tem
                  limites no plano gratuito — evitamos next/image de propósito. */}
              {line.imageUrl ? (
                <img
                  src={line.imageUrl}
                  alt={line.name}
                  loading="lazy"
                  width={80}
                  height={80}
                  className="h-20 w-20 shrink-0 rounded-xl border border-zinc-100 object-cover dark:border-zinc-800"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800"
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
                      className="line-clamp-2 text-sm font-medium text-zinc-900 hover:text-amber-800 dark:text-zinc-100 dark:hover:text-amber-400"
                    >
                      {line.name}
                    </Link>
                    {line.attributesLabel ? (
                      <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {line.attributesLabel}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem(line.variantId)}
                    aria-label={`Remover ${line.name} da sacola`}
                    className="shrink-0 rounded-full p-1 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
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
                  <div className="flex items-center gap-1 rounded-full border border-zinc-200 dark:border-zinc-700">
                    <button
                      type="button"
                      onClick={() => setQuantity(line.variantId, line.quantity - 1)}
                      aria-label={`Diminuir quantidade de ${line.name}`}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      −
                    </button>
                    <span
                      aria-label={`Quantidade: ${line.quantity}`}
                      className="min-w-6 text-center text-sm font-medium text-zinc-900 tabular-nums dark:text-zinc-100"
                    >
                      {line.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQuantity(line.variantId, line.quantity + 1)}
                      disabled={line.quantity >= line.availableQty}
                      aria-label={`Aumentar quantidade de ${line.name}`}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      +
                    </button>
                  </div>

                  <div className="text-right">
                    <Money
                      cents={line.priceCents * line.quantity}
                      className="text-base font-semibold text-amber-800 dark:text-amber-400"
                    />
                    {line.quantity > 1 ? (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        <Money cents={line.priceCents} /> cada
                      </p>
                    ) : null}
                  </div>
                </div>

                {line.quantity >= line.availableQty ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Só {line.availableQty} em estoque.
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        {/* Frete + resumo */}
        <div className="space-y-4">
          <section
            aria-labelledby="frete-title"
            className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            <h2
              id="frete-title"
              className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
            >
              Calcular frete e prazo
            </h2>
            <form onSubmit={handleQuoteSubmit} className="mt-3 flex gap-2">
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
                className="w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-amber-700 focus:ring-2 focus:ring-amber-700/25 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              />
              <button
                type="submit"
                disabled={pending}
                className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {pending ? "Calculando…" : "Calcular"}
              </button>
            </form>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              <a
                href="https://buscacepinter.correios.com.br/app/endereco/index.php"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-800 dark:hover:text-amber-400"
              >
                Não sei meu CEP
              </a>
            </p>

            {quote.status === "error" ? (
              <p
                role="alert"
                className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              >
                {quote.message}
              </p>
            ) : null}

            {quote.status === "done" && quote.quotes.length === 0 ? (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
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
                        "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                        selectedRateId === option.rateId
                          ? "border-amber-700 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/40"
                          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600",
                      ].join(" ")}
                    >
                      <input
                        type="radio"
                        name="shippingRate"
                        value={option.rateId}
                        checked={selectedRateId === option.rateId}
                        onChange={() => setSelectedRateId(option.rateId)}
                        className="h-4 w-4 accent-amber-700"
                      />
                      <span className="flex flex-1 items-baseline justify-between gap-2 text-sm">
                        <span className="min-w-0">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                            {option.name}
                          </span>{" "}
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {deliveryLabel(option)}
                          </span>
                        </span>
                        {option.priceCents === 0 ? (
                          <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                            Grátis
                          </span>
                        ) : (
                          <Money
                            cents={option.priceCents}
                            className="font-semibold text-zinc-900 dark:text-zinc-100"
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
            className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
          >
            {/* Cupom de desconto */}
            <div className="mb-3 border-b border-zinc-200 pb-3 dark:border-zinc-700">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Cupom de desconto
              </h2>
              {appliedCoupon ? (
                <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-emerald-700 dark:text-emerald-400">
                    {appliedCoupon.code} aplicado
                  </span>
                  <button
                    type="button"
                    onClick={removeCoupon}
                    className="text-xs text-zinc-500 underline hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                  >
                    remover cupom
                  </button>
                </div>
              ) : (
                <form onSubmit={handleCouponSubmit} className="mt-2 flex gap-2">
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
                    className="w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm uppercase text-zinc-900 placeholder:normal-case placeholder:text-zinc-400 focus:border-amber-700 focus:ring-2 focus:ring-amber-700/25 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  />
                  <button
                    type="submit"
                    disabled={couponPending || couponInput.trim() === ""}
                    className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {couponPending ? "Aplicando…" : "Aplicar"}
                  </button>
                </form>
              )}
              {coupon.status === "error" ? (
                <p
                  role="alert"
                  className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                >
                  {coupon.message}
                </p>
              ) : null}
            </div>

            <dl className="space-y-2 text-sm">
              <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                <dt>Subtotal</dt>
                <dd>
                  <Money cents={subtotalCents} />
                </dd>
              </div>
              {appliedCoupon ? (
                <div className="flex justify-between font-medium text-emerald-700 dark:text-emerald-400">
                  <dt>Desconto</dt>
                  <dd>
                    − <Money cents={appliedCoupon.discountCents} /> (
                    {appliedCoupon.code})
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                <dt>Frete</dt>
                <dd>
                  {selectedQuote ? (
                    selectedQuote.priceCents === 0 ? (
                      <span className="font-medium text-emerald-700 dark:text-emerald-400">
                        Grátis
                      </span>
                    ) : (
                      <Money cents={selectedQuote.priceCents} />
                    )
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-500">
                      calcule acima
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex justify-between border-t border-zinc-200 pt-2 text-base font-semibold text-zinc-900 dark:border-zinc-700 dark:text-zinc-100">
                <dt>Total</dt>
                <dd>
                  <Money
                    cents={totalCents}
                    className="text-amber-800 dark:text-amber-400"
                  />
                </dd>
              </div>
            </dl>

            {checkoutHref ? (
              <Link
                href={checkoutHref}
                className="mt-4 flex w-full items-center justify-center rounded-full bg-amber-700 px-6 py-3.5 text-base font-semibold text-white transition-colors hover:bg-amber-800"
              >
                Fechar pedido
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  disabled
                  className="mt-4 flex w-full cursor-not-allowed items-center justify-center rounded-full bg-zinc-300 px-6 py-3.5 text-base font-semibold text-zinc-500 dark:bg-zinc-800"
                >
                  Fechar pedido
                </button>
                <p className="mt-2 text-center text-xs text-zinc-500 dark:text-zinc-400">
                  Calcule o frete para continuar.
                </p>
              </>
            )}

            <Link
              href="/produtos"
              className="mt-3 block text-center text-sm text-zinc-600 underline hover:text-amber-800 dark:text-zinc-400 dark:hover:text-amber-400"
            >
              Continuar comprando
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
