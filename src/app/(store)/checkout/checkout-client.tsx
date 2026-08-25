"use client";

// Checkout em uma tela: resumo dos itens + frete re-cotado no servidor +
// formulário de dados/entrega. O total exibido aqui é só informativo — quem
// manda é o recálculo do servidor em createStoreOrder (expected* detecta
// qualquer divergência e o cliente confirma antes de seguir).

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import { useCart } from "@/components/store/cart/cart-context";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { normalizeDocument } from "@/lib/document";
import { toE164BR } from "@/lib/phone";
import type { ShippingQuote } from "@/services/store-catalog";
import type { CreateStoreOrderInput, PriceChange } from "@/services/store-orders";

import { quoteCouponAction, quoteShippingAction } from "../carrinho/actions";
import { placeOrderAction } from "./actions";

const UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS",
  "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC",
  "SP", "SE", "TO",
] as const;

const inputClasses =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-amber-700 focus:ring-2 focus:ring-amber-700/25 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500";

function formatCep(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

/** Máscara leve de CPF (11 dígitos) ou CNPJ (12–14 dígitos). */
function formatDocument(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 14);
  if (digits.length <= 11) {
    return digits
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4");
  }
  return digits
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3/$4")
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, "$1.$2.$3/$4-$5");
}

/** Máscara leve de telefone BR: (11) 99999-9999. */
function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function deliveryLabel(quote: ShippingQuote): string {
  const { deliveryDaysMin: min, deliveryDaysMax: max } = quote;
  if (min === max) return min === 1 ? "1 dia útil" : `${min} dias úteis`;
  return `${min}–${max} dias úteis`;
}

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; quotes: ShippingQuote[]; whatsappUrl: string | null };

export function CheckoutClient({
  initialCepDigits,
  initialRateId,
  initialCouponCode,
}: {
  initialCepDigits: string;
  initialRateId: string;
  initialCouponCode: string;
}) {
  const router = useRouter();
  const { items, subtotalCents, clear, updatePrices } = useCart();

  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- marca pós-mount p/ hidratação SSR-safe do carrinho
  useEffect(() => setMounted(true), []);
  const [placed, setPlaced] = useState(false);

  // ----- Campos com máscara (controlados) --------------------------------
  const [documentValue, setDocumentValue] = useState("");
  const [phoneValue, setPhoneValue] = useState("");
  const [cepValue, setCepValue] = useState(formatCep(initialCepDigits));
  const [fieldErrors, setFieldErrors] = useState<{
    document?: string;
    phone?: string;
    cep?: string;
  }>({});

  // ----- Frete: re-cotado no servidor ao montar e quando CEP/itens mudam --
  const cepDigits = cepValue.replace(/\D/g, "");
  const itemsKey = items
    .map((line) => `${line.variantId}:${line.quantity}`)
    .join(",");
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [selectedRateId, setSelectedRateId] = useState(initialRateId || null);
  const [shippingCentsOverride, setShippingCentsOverride] = useState<number | null>(
    null,
  );
  const [, startQuote] = useTransition();
  const lastQuoteKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!mounted || items.length === 0) return;
    if (cepDigits.length !== 8) {
      // CEP incompleto: some com a cotação antiga e espere o CEP completo.
      lastQuoteKeyRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- limpa cotação quando o CEP fica incompleto (pós-hidratação)
      setQuote({ status: "idle" });
      return;
    }
    const key = `${cepDigits}|${itemsKey}`;
    if (lastQuoteKeyRef.current === key) return;
    lastQuoteKeyRef.current = key;
    setQuote({ status: "loading" });
    startQuote(async () => {
      const result = await quoteShippingAction({
        cep: cepDigits,
        items: items.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
        })),
      });
      if (!result.ok) {
        setQuote({ status: "error", message: result.error });
        return;
      }
      setQuote({
        status: "done",
        quotes: result.quotes,
        whatsappUrl: result.whatsappUrl,
      });
      setShippingCentsOverride(null);
      setSelectedRateId((current) => {
        if (current && result.quotes.some((q) => q.rateId === current)) {
          return current;
        }
        return result.quotes[0]?.rateId ?? null;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, cepDigits, itemsKey]);

  // ----- Cupom: re-cotado no servidor ao montar e quando a sacola muda -----
  const [couponCode, setCouponCode] = useState<string | null>(
    initialCouponCode.trim() ? initialCouponCode.trim().toUpperCase() : null,
  );
  const [appliedCoupon, setAppliedCoupon] = useState<{
    code: string;
    discountCents: number;
  } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [, startCouponQuote] = useTransition();
  const lastCouponKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!mounted || items.length === 0) return;
    if (!couponCode) {
      lastCouponKeyRef.current = null;
      return;
    }
    const key = `${couponCode}|${itemsKey}`;
    if (lastCouponKeyRef.current === key) return;
    lastCouponKeyRef.current = key;
    startCouponQuote(async () => {
      const result = await quoteCouponAction({
        code: couponCode,
        items: items.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
        })),
      });
      if (result.ok) {
        setAppliedCoupon({
          code: result.code,
          discountCents: result.discountCents,
        });
        setCouponError(null);
        return;
      }
      // Cupom inválido AGORA (expirou/esgotou entre carrinho e checkout):
      // some com o desconto do resumo e mostra o motivo. O código continua no
      // payload — se o cliente insistir em fechar, o servidor rejeita com a
      // mesma mensagem SEM criar pedido.
      setAppliedCoupon(null);
      setCouponError(result.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, couponCode, itemsKey]);

  function removeCoupon() {
    setCouponCode(null);
    setAppliedCoupon(null);
    setCouponError(null);
  }

  const quotes = quote.status === "done" ? quote.quotes : [];
  const selectedQuote =
    quotes.find((q) => q.rateId === selectedRateId) ?? null;
  const shippingCents =
    shippingCentsOverride ?? selectedQuote?.priceCents ?? null;
  const discountCents = appliedCoupon?.discountCents ?? 0;
  const totalCents = subtotalCents - discountCents + (shippingCents ?? 0);

  // ----- Envio do pedido ---------------------------------------------------
  const [submitting, startSubmit] = useTransition();
  const [submitError, setSubmitError] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [priceChanges, setPriceChanges] = useState<PriceChange[] | null>(null);
  const [shippingChanged, setShippingChanged] = useState<number | null>(null);
  const lastPayloadRef = useRef<CreateStoreOrderInput | null>(null);

  const submitPayload = useCallback(
    (payload: CreateStoreOrderInput) => {
      lastPayloadRef.current = payload;
      setSubmitError(null);
      setPriceChanges(null);
      setShippingChanged(null);
      startSubmit(async () => {
        const result = await placeOrderAction(payload);
        if (result.ok) {
          setPlaced(true);
          clear();
          if (result.initPointUrl) {
            // Mercado Pago habilitado: vai DIRETO para o Checkout Pro pagar
            // agora. O back_url do MP traz o cliente de volta para
            // /pedido/[token], que mostra o status real do banco.
            window.location.assign(result.initPointUrl);
            return;
          }
          // Fluxo manual: página do pedido (pagamento combinado no WhatsApp).
          router.replace(`/pedido/${result.publicToken}?novo=1`);
          return;
        }
        if (result.kind === "price_changed") {
          setPriceChanges(result.changes);
          return;
        }
        if (result.kind === "shipping_changed") {
          setShippingChanged(result.newShippingCents);
          return;
        }
        setSubmitError({ code: result.code, message: result.message });
      });
    },
    [clear, router, startSubmit],
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const errors: typeof fieldErrors = {};

    // Validação client-side ANTES de enviar (o servidor revalida tudo).
    const doc = normalizeDocument(documentValue);
    if (!doc) errors.document = "CPF ou CNPJ inválido. Confira os dígitos.";
    const phoneE164 = toE164BR(phoneValue);
    if (!phoneE164) errors.phone = "Telefone inválido. Informe DDD + número.";
    if (cepDigits.length !== 8) errors.cep = "CEP inválido. Use 8 dígitos.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSubmitError({
        code: "VALIDATION",
        message: "Corrija os campos destacados acima para continuar.",
      });
      return;
    }
    if (!selectedQuote || shippingCents === null) {
      setSubmitError({
        code: "NO_SHIPPING",
        message: "Escolha uma opção de entrega para continuar.",
      });
      return;
    }

    const email = String(form.get("email") ?? "").trim();
    const complement = String(form.get("complement") ?? "").trim();
    const payload: CreateStoreOrderInput = {
      customer: {
        fullName: String(form.get("fullName") ?? "").trim(),
        document: documentValue,
        phone: phoneValue,
        ...(email ? { email } : {}),
        marketingOptIn: form.get("marketingOptIn") === "on",
      },
      address: {
        postalCode: cepDigits,
        street: String(form.get("street") ?? "").trim(),
        number: String(form.get("number") ?? "").trim(),
        ...(complement ? { complement } : {}),
        district: String(form.get("district") ?? "").trim(),
        city: String(form.get("city") ?? "").trim(),
        state: String(form.get("state") ?? ""),
      },
      items: items.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        expectedUnitPriceCents: line.priceCents,
      })),
      shippingRateId: selectedQuote.rateId,
      expectedShippingCents: shippingCents,
      ...(couponCode ? { couponCode } : {}),
    };
    submitPayload(payload);
  }

  /** "Alguns preços mudaram" → atualiza a sacola e reenvia com os novos valores. */
  function acceptPriceChanges() {
    if (!priceChanges || !lastPayloadRef.current) return;
    updatePrices(
      priceChanges.map((change) => ({
        variantId: change.variantId,
        newPriceCents: change.newPriceCents,
      })),
    );
    const newPriceByVariant = new Map(
      priceChanges.map((change) => [change.variantId, change.newPriceCents]),
    );
    submitPayload({
      ...lastPayloadRef.current,
      items: lastPayloadRef.current.items.map((item) => ({
        ...item,
        expectedUnitPriceCents:
          newPriceByVariant.get(item.variantId) ?? item.expectedUnitPriceCents,
      })),
    });
  }

  /** "O frete mudou" → aceita o novo valor e reenvia. */
  function acceptShippingChange() {
    if (shippingChanged === null || !lastPayloadRef.current) return;
    setShippingCentsOverride(shippingChanged);
    submitPayload({
      ...lastPayloadRef.current,
      expectedShippingCents: shippingChanged,
    });
  }

  // ------------------------------------------------------------------------

  if (!mounted) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <div
          aria-busy="true"
          aria-label="Carregando o checkout"
          className="animate-pulse space-y-4"
        >
          <div className="h-8 w-52 rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-32 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
          <div className="h-72 rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>
    );
  }

  if (items.length === 0 && !placed) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Finalizar pedido
        </h1>
        <EmptyState
          title="Sua sacola está vazia"
          hint="Adicione produtos antes de fechar o pedido."
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
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
        Finalizar pedido
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        <Link
          href="/carrinho"
          className="underline hover:text-amber-800 dark:hover:text-amber-400"
        >
          Voltar para a sacola
        </Link>
      </p>

      {/* Resumo compacto dos itens */}
      <section
        aria-label="Resumo da sacola"
        className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {items.map((line) => (
            <li key={line.variantId} className="flex items-center gap-3 py-2.5">
              {/* <img> simples (lazy): otimizador da Vercel tem limites no plano. */}
              {line.imageUrl ? (
                <img
                  src={line.imageUrl}
                  alt={line.name}
                  loading="lazy"
                  width={48}
                  height={48}
                  className="h-12 w-12 shrink-0 rounded-lg border border-zinc-100 object-cover dark:border-zinc-800"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="h-12 w-12 shrink-0 rounded-lg bg-zinc-100 dark:bg-zinc-800"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">
                  {line.name}
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {line.attributesLabel ? `${line.attributesLabel} · ` : ""}
                  {line.quantity}×
                </p>
              </div>
              <Money
                cents={line.priceCents * line.quantity}
                className="text-sm font-medium text-zinc-900 dark:text-zinc-100"
              />
            </li>
          ))}
        </ul>

        {/* Frete escolhido, com preço re-cotado agora no servidor */}
        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
          {quote.status === "idle" ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Informe o CEP completo no endereço abaixo para calcular a entrega.
            </p>
          ) : null}
          {quote.status === "loading" ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400" role="status">
              Atualizando o frete…
            </p>
          ) : null}
          {quote.status === "error" ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {quote.message}
            </p>
          ) : null}
          {quote.status === "done" && quotes.length === 0 ? (
            <p
              role="alert"
              className="text-sm text-amber-900 dark:text-amber-200"
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
            </p>
          ) : null}
          {quotes.length > 0 ? (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Entrega
              </legend>
              <div className="space-y-2">
                {quotes.map((option) => (
                  <label
                    key={option.rateId}
                    className={[
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors",
                      selectedRateId === option.rateId
                        ? "border-amber-700 bg-amber-50 dark:border-amber-500 dark:bg-amber-950/40"
                        : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600",
                    ].join(" ")}
                  >
                    <input
                      type="radio"
                      name="shippingOption"
                      value={option.rateId}
                      checked={selectedRateId === option.rateId}
                      onChange={() => {
                        setSelectedRateId(option.rateId);
                        setShippingCentsOverride(null);
                      }}
                      className="h-4 w-4 accent-amber-700"
                    />
                    <span className="flex flex-1 items-baseline justify-between gap-2">
                      <span>
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
        </div>

        {/* Cupom aplicado / problema com o cupom */}
        {couponError ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200"
          >
            <p>{couponError}</p>
            <button
              type="button"
              onClick={removeCoupon}
              className="mt-1 text-xs font-semibold underline"
            >
              remover cupom
            </button>
          </div>
        ) : null}

        <dl className="mt-3 space-y-1.5 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-700">
          <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
            <dt>Subtotal</dt>
            <dd>
              <Money cents={subtotalCents} />
            </dd>
          </div>
          {appliedCoupon ? (
            <div className="flex justify-between font-medium text-emerald-700 dark:text-emerald-400">
              <dt className="flex items-center gap-2">
                Desconto
                <button
                  type="button"
                  onClick={removeCoupon}
                  className="text-xs font-normal text-zinc-500 underline hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
                >
                  remover
                </button>
              </dt>
              <dd>
                − <Money cents={appliedCoupon.discountCents} /> (
                {appliedCoupon.code})
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
            <dt>Frete</dt>
            <dd>
              {shippingCents === null ? (
                "—"
              ) : shippingCents === 0 ? (
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  Grátis
                </span>
              ) : (
                <Money cents={shippingCents} />
              )}
            </dd>
          </div>
          <div className="flex justify-between text-base font-semibold text-zinc-900 dark:text-zinc-100">
            <dt>Total</dt>
            <dd>
              <Money
                cents={totalCents}
                className="text-amber-800 dark:text-amber-400"
              />
            </dd>
          </div>
        </dl>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
          O total é confirmado pelo servidor no envio do pedido.
        </p>
      </section>

      {/* Formulário */}
      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        <section
          aria-labelledby="dados-title"
          className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2
            id="dados-title"
            className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100"
          >
            Seus dados
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome completo" className="sm:col-span-2">
              <input
                name="fullName"
                required
                autoComplete="name"
                placeholder="Como no seu documento"
                className={inputClasses}
              />
            </Field>
            <Field
              label="CPF ou CNPJ"
              hint="Usado para a emissão da nota fiscal."
              error={fieldErrors.document}
            >
              <input
                name="document"
                required
                inputMode="numeric"
                autoComplete="off"
                placeholder="000.000.000-00"
                value={documentValue}
                onChange={(event) =>
                  setDocumentValue(formatDocument(event.target.value))
                }
                aria-invalid={fieldErrors.document ? true : undefined}
                className={inputClasses}
              />
            </Field>
            <Field label="WhatsApp / telefone" error={fieldErrors.phone}>
              <input
                name="phone"
                required
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                placeholder="(11) 99999-9999"
                value={phoneValue}
                onChange={(event) => setPhoneValue(formatPhone(event.target.value))}
                aria-invalid={fieldErrors.phone ? true : undefined}
                className={inputClasses}
              />
            </Field>
            <Field label="E-mail (opcional)" className="sm:col-span-2">
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="voce@exemplo.com"
                className={inputClasses}
              />
            </Field>
          </div>
        </section>

        <section
          aria-labelledby="entrega-title"
          className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2
            id="entrega-title"
            className="mb-4 text-base font-semibold text-zinc-900 dark:text-zinc-100"
          >
            Endereço de entrega
          </h2>
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="CEP" error={fieldErrors.cep} className="sm:col-span-2">
              <input
                name="postalCode"
                required
                inputMode="numeric"
                autoComplete="postal-code"
                placeholder="00000-000"
                value={cepValue}
                onChange={(event) => setCepValue(formatCep(event.target.value))}
                aria-invalid={fieldErrors.cep ? true : undefined}
                className={inputClasses}
              />
            </Field>
            <Field label="Rua / avenida" className="sm:col-span-4">
              <input
                name="street"
                required
                autoComplete="address-line1"
                className={inputClasses}
              />
            </Field>
            <Field label="Número" className="sm:col-span-2">
              <input name="number" required className={inputClasses} />
            </Field>
            <Field label="Complemento (opcional)" className="sm:col-span-4">
              <input
                name="complement"
                autoComplete="address-line2"
                placeholder="Apto, bloco, referência…"
                className={inputClasses}
              />
            </Field>
            <Field label="Bairro" className="sm:col-span-2">
              <input name="district" required className={inputClasses} />
            </Field>
            <Field label="Cidade" className="sm:col-span-2">
              <input
                name="city"
                required
                autoComplete="address-level2"
                className={inputClasses}
              />
            </Field>
            <Field label="Estado (UF)" className="sm:col-span-2">
              <select
                name="state"
                required
                defaultValue=""
                autoComplete="address-level1"
                className={inputClasses}
              >
                <option value="" disabled>
                  Selecione
                </option>
                {UFS.map((uf) => (
                  <option key={uf} value={uf}>
                    {uf}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>

        {/* LGPD: opt-in começa DESMARCADO — nunca assumido. */}
        <label className="flex items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          <input
            type="checkbox"
            name="marketingOptIn"
            className="mt-0.5 h-4 w-4 accent-amber-700"
          />
          <span>Quero receber atualizações do pedido pelo WhatsApp.</span>
        </label>

        {/* Divergência de preço detectada pelo servidor */}
        {priceChanges ? (
          <div
            role="alert"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/50"
          >
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Alguns preços mudaram desde que você montou a sacola
            </p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-amber-800 dark:text-amber-300">
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Item
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      Antes
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Agora
                    </th>
                  </tr>
                </thead>
                <tbody className="text-amber-950 dark:text-amber-100">
                  {priceChanges.map((change) => (
                    <tr key={change.variantId}>
                      <td className="py-1 pr-2">{change.name}</td>
                      <td className="py-1 pr-2 line-through opacity-70">
                        <Money cents={change.oldPriceCents} />
                      </td>
                      <td className="py-1 font-semibold">
                        <Money cents={change.newPriceCents} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={acceptPriceChanges}
              disabled={submitting}
              className="mt-3 rounded-full bg-amber-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-800 disabled:opacity-60"
            >
              {submitting ? "Enviando pedido…" : "Atualizar e continuar"}
            </button>
          </div>
        ) : null}

        {/* Divergência de frete detectada pelo servidor */}
        {shippingChanged !== null ? (
          <div
            role="alert"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/50"
          >
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              O valor do frete mudou
            </p>
            <p className="mt-1 text-sm text-amber-950 dark:text-amber-100">
              {shippingCents !== null ? (
                <>
                  <span className="line-through opacity-70">
                    <Money cents={shippingCents} />
                  </span>{" "}
                  →{" "}
                </>
              ) : null}
              <span className="font-semibold">
                <Money cents={shippingChanged} />
              </span>
            </p>
            <button
              type="button"
              onClick={acceptShippingChange}
              disabled={submitting}
              className="mt-3 rounded-full bg-amber-700 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-800 disabled:opacity-60"
            >
              {submitting ? "Enviando pedido…" : "Atualizar e continuar"}
            </button>
          </div>
        ) : null}

        {/* Erros gerais, sempre visíveis perto do botão */}
        {submitError ? (
          <div
            role="alert"
            className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
          >
            <p>{submitError.message}</p>
            {submitError.code.startsWith("COUPON_") ? (
              <button
                type="button"
                onClick={() => {
                  removeCoupon();
                  setSubmitError(null);
                }}
                className="mt-2 inline-block font-semibold underline"
              >
                Remover o cupom e continuar sem desconto
              </button>
            ) : null}
            {submitError.code === "OUT_OF_STOCK" ||
            submitError.code === "VARIANT_UNAVAILABLE" ||
            submitError.code === "NO_ACTIVE_PRICE" ? (
              <Link
                href="/carrinho"
                className="mt-2 inline-block font-semibold underline"
              >
                Ajustar a sacola
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-3">
          <button
            type="submit"
            disabled={submitting || quote.status === "loading"}
            className="flex w-full items-center justify-center rounded-full bg-amber-700 px-6 py-4 text-base font-semibold text-white transition-colors hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Enviando pedido…" : "Fechar pedido"}
          </button>
          <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
            Ao fechar o pedido, você concorda com os{" "}
            <Link
              href="/termos"
              className="underline hover:text-amber-800 dark:hover:text-amber-400"
            >
              termos de compra
            </Link>
            . Pagamento combinado pelo WhatsApp após o envio.
          </p>
        </div>
      </form>
    </div>
  );
}
