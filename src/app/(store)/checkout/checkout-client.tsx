"use client";

// Checkout em uma tela — "o formulário" no papel timbrado da maison: o resumo
// (a folha) + o formulário em três seções numeradas, com as opções de entrega
// logo abaixo do CEP e o fecho noir com o total e o botão ouro. O total
// exibido aqui é só informativo — quem manda é o recálculo do servidor em
// createStoreOrder (expected* detecta qualquer divergência e o cliente
// confirma antes de seguir). A lógica de estado é a mesma da versão anterior.

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
import { CheckoutSkeleton } from "@/components/store/cart/checkout-skeleton";
import { FormSection } from "@/components/store/checkout/form-section";
import { PriceChangesTable } from "@/components/store/checkout/price-changes";
import { EmptyState } from "@/components/store/empty-state";
import { Field } from "@/components/store/field";
import { NoirStage } from "@/components/store/noir-stage";
import { deliveryLabel } from "@/components/store/order/delivery-label";
import { Notice } from "@/components/store/order/notice";
import { OptionCard } from "@/components/store/order/option-card";
import { Sheet } from "@/components/store/order/sheet";
import { TotalsList } from "@/components/store/order/totals";
import { Ribbon } from "@/components/store/ribbon";
import {
  btnGold,
  btnPrimary,
  eyebrow,
  eyebrowNoir,
  inputBase,
  linkGold,
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { formatCep } from "@/lib/cep";
import { normalizeDocument } from "@/lib/document";
import { formatCentsBRL } from "@/lib/money";
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

const inputClasses = cx(
  inputBase,
  "disabled:cursor-not-allowed disabled:opacity-60",
);

const smallLink =
  "inline-flex min-h-11 items-center font-store text-xs tracking-[0.12em] uppercase underline underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-600";

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

type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; quotes: ShippingQuote[]; whatsappUrl: string | null };

const PAYMENT_OPTIONS = [
  {
    value: "online",
    title: "Pagar agora — Pix ou cartão",
    detail: "Com segurança, logo depois de fechar o pedido.",
  },
  {
    value: "cash",
    title: "Pagar na entrega, em dinheiro",
    detail: "Você paga ao receber; combinamos os detalhes pelo WhatsApp.",
  },
] as const;

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

  // ----- Forma de pagamento: online (MP) ou dinheiro na entrega ------------
  const [paymentMethod, setPaymentMethod] = useState<"online" | "cash">(
    "online",
  );

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

  // Resumo compacto no celular: a partir de 4 peças, as demais ficam
  // dobradas até "Ver as N peças".
  const [expanded, setExpanded] = useState(false);

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
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
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
      // Leva o foco ao primeiro campo com erro depois que ele for pintado.
      requestAnimationFrame(() => {
        formElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
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
      paymentMethod,
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
    return <CheckoutSkeleton />;
  }

  if (items.length === 0 && !placed) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
        <header className="mb-8 flex flex-col items-start gap-2">
          <p className={eyebrow}>Pedido</p>
          <h1 className="font-display text-title font-semibold text-espresso-900">
            Fechar pedido
          </h1>
          <Ribbon variant="static" size="sm" className="mt-1" />
        </header>
        <EmptyState
          title="Sua sacola ainda está vazia"
          hint="Escolha suas peças antes de fechar o pedido."
          action={
            <Link href="/produtos" className={btnPrimary}>
              Ver a coleção
            </Link>
          }
        />
      </div>
    );
  }

  const count = items.reduce((sum, line) => sum + line.quantity, 0);
  const folded = items.length > 3 && !expanded;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-col items-start gap-2">
        <p className={eyebrow}>
          Pedido · {count} {count === 1 ? "peça" : "peças"}
        </p>
        <h1 className="font-display text-title font-semibold text-espresso-900">
          Fechar pedido
        </h1>
        <Ribbon variant="static" size="sm" className="mt-1" />
        <Link
          href="/carrinho"
          className={cx(smallLink, "text-ink-700 decoration-gold-500 hover:text-gold-800")}
        >
          Voltar à sacola
        </Link>
      </header>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-x-16">
        {/* O resumo vem primeiro no DOM (celular: em cima); no desktop vai
            para a coluna da direita, grudado. */}
        <Sheet
          eyebrow="Resumo"
          headingId="resumo-title"
          aria-labelledby="resumo-title"
          ornament
          sticky
          className="lg:col-start-2 lg:row-start-1"
        >
          <a
            href="#dados-title"
            className="sr-only focus:not-sr-only focus:mt-3 focus:inline-flex focus:min-h-11 focus:items-center focus:font-store focus:text-xs focus:uppercase focus:text-gold-800 focus:underline focus:outline-2 focus:outline-offset-2 focus:outline-gold-600 lg:block"
          >
            Ir para o formulário
          </a>
          <ul
            className={cx(
              "mt-4 divide-y divide-ivory-200",
              folded && "[&>li:nth-child(n+4)]:hidden lg:[&>li:nth-child(n+4)]:flex",
            )}
          >
            {items.map((line) => (
              <li key={line.variantId} className="flex items-center gap-3 py-3">
                {line.imageUrl ? (
                  <img
                    src={line.imageUrl}
                    alt=""
                    loading="lazy"
                    width={40}
                    height={50}
                    className="aspect-(--aspect-product) w-10 shrink-0 rounded-(--radius-hair) border border-ivory-300 object-cover"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex aspect-(--aspect-product) w-10 shrink-0 items-center justify-center rounded-(--radius-hair) border border-ivory-300 bg-ivory-150 font-display text-lg font-semibold text-ivory-400"
                  >
                    {line.name.trim().charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-store text-sm font-medium text-ink-900">
                    {line.name}
                  </p>
                  <p className="font-store text-xs text-ink-500 tabular-nums">
                    {line.attributesLabel ? `${line.attributesLabel} · ` : ""}
                    {line.quantity}×
                  </p>
                </div>
                <p className="shrink-0 font-store text-sm font-medium text-ink-900 tabular-nums">
                  {formatCentsBRL(line.priceCents * line.quantity)}
                </p>
              </li>
            ))}
          </ul>
          {folded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className={cx(smallLink, "text-ink-700 hover:text-gold-800 lg:hidden")}
            >
              Ver as {items.length} peças
            </button>
          ) : null}

          {couponError ? (
            <Notice tone="gold" role="alert" className="mt-4">
              <p>{couponError}</p>
              <button
                type="button"
                onClick={removeCoupon}
                className={cx(smallLink, "text-ink-700 hover:text-claret-700")}
              >
                remover cupom
              </button>
            </Notice>
          ) : null}

          <TotalsList
            className="mt-4 border-t border-ivory-300 pt-4"
            subtotalCents={subtotalCents}
            discountCents={discountCents}
            discountLabel={
              appliedCoupon ? `Desconto (${appliedCoupon.code})` : "Desconto"
            }
            onRemoveDiscount={appliedCoupon ? removeCoupon : undefined}
            shippingCents={shippingCents}
            shippingFallback="—"
            totalCents={totalCents}
          />
          <p className="mt-2 font-store text-xs text-ink-500">
            O total é confirmado pelo servidor no envio do pedido.
          </p>
        </Sheet>

        {/* O formulário */}
        <form
          onSubmit={handleSubmit}
          noValidate
          className="space-y-8 lg:col-start-1 lg:row-start-1"
        >
          <FormSection id="dados-title" number="01" title="Seus dados">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Nome completo"
                hint="Como está no seu documento."
                className="sm:col-span-2"
              >
                <input
                  name="fullName"
                  required
                  autoComplete="name"
                  className={inputClasses}
                />
              </Field>
              <Field
                label="CPF ou CNPJ"
                hint="Usado para a emissão da nota fiscal."
                error={fieldErrors.document}
              >
                <input
                  id="document"
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
                  id="phone"
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
          </FormSection>

          <FormSection id="entrega-title" number="02" title="Entrega">
            <div className="grid gap-4 sm:grid-cols-6">
              <Field label="CEP" error={fieldErrors.cep} className="sm:col-span-2">
                <input
                  id="postalCode"
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

              {/* As opções de entrega vivem aqui, logo abaixo do CEP: no
                  celular quem digita o CEP vê a cotação no mesmo lugar. */}
              <div className="sm:col-span-6">
                {quote.status === "idle" ? (
                  <p className="font-store text-sm text-ink-500">
                    Informe o CEP completo para calcular a entrega.
                  </p>
                ) : null}
                {quote.status === "loading" ? (
                  <p className="font-store text-sm text-ink-500" role="status">
                    Atualizando a entrega…
                  </p>
                ) : null}
                {quote.status === "error" ? (
                  <Notice tone="claret" role="alert">
                    {quote.message}
                  </Notice>
                ) : null}
                {quote.status === "done" && quotes.length === 0 ? (
                  <Notice tone="gold" role="alert">
                    Ainda não entregamos para este CEP —{" "}
                    {quote.whatsappUrl ? (
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
                {quotes.length > 0 ? (
                  <fieldset>
                    <legend className={cx(eyebrow, "mb-2")}>Opções de entrega</legend>
                    <div className="space-y-2">
                      {quotes.map((option) => (
                        <OptionCard
                          key={option.rateId}
                          name="shippingOption"
                          value={option.rateId}
                          checked={selectedRateId === option.rateId}
                          onChange={() => {
                            setSelectedRateId(option.rateId);
                            setShippingCentsOverride(null);
                          }}
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
              </div>

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
              <Field
                label="Complemento (opcional)"
                hint="Apto, bloco, ponto de referência."
                className="sm:col-span-4"
              >
                <input
                  name="complement"
                  autoComplete="address-line2"
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
          </FormSection>

          <FormSection id="pagamento-title" number="03" title="Pagamento">
            <fieldset>
              <legend className="sr-only">Forma de pagamento</legend>
              <div className="space-y-2">
                {PAYMENT_OPTIONS.map((option) => (
                  <OptionCard
                    key={option.value}
                    name="paymentMethod"
                    value={option.value}
                    checked={paymentMethod === option.value}
                    onChange={() => setPaymentMethod(option.value)}
                    title={option.title}
                    detail={option.detail}
                  />
                ))}
              </div>
            </fieldset>

            {/* LGPD: opt-in começa DESMARCADO — nunca assumido. O texto diz
                exatamente o que chega: os avisos deste pedido. */}
            <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 font-store text-sm text-ink-700">
              <input
                type="checkbox"
                name="marketingOptIn"
                className="mt-0.5 h-5 w-5 shrink-0 accent-gold-600"
              />
              <span>
                Quero receber os avisos deste pedido (confirmação, pagamento e
                envio) pelo WhatsApp.
              </span>
            </label>
          </FormSection>

          {/* Divergência de preço detectada pelo servidor */}
          {priceChanges ? (
            <Notice
              tone="gold"
              role="alert"
              title="Alguns preços mudaram desde que você montou a sacola"
            >
              <PriceChangesTable changes={priceChanges} />
              <button
                type="button"
                onClick={acceptPriceChanges}
                disabled={submitting}
                className={cx(
                  btnPrimary,
                  "mt-4 disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {submitting ? "Enviando pedido…" : "Atualizar e continuar"}
              </button>
            </Notice>
          ) : null}

          {/* Divergência de frete detectada pelo servidor */}
          {shippingChanged !== null ? (
            <Notice tone="gold" role="alert" title="O valor da entrega mudou">
              <p className="tabular-nums">
                {shippingCents !== null ? (
                  <>
                    <span className="line-through opacity-60">
                      {formatCentsBRL(shippingCents)}
                    </span>{" "}
                    →{" "}
                  </>
                ) : null}
                <span className="font-semibold">{formatCentsBRL(shippingChanged)}</span>
              </p>
              <button
                type="button"
                onClick={acceptShippingChange}
                disabled={submitting}
                className={cx(
                  btnPrimary,
                  "mt-4 disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {submitting ? "Enviando pedido…" : "Atualizar e continuar"}
              </button>
            </Notice>
          ) : null}

          {/* Erros gerais, sempre visíveis perto do botão */}
          {submitError ? (
            <Notice tone="claret" role="alert">
              <p>{submitError.message}</p>
              {submitError.code.startsWith("COUPON_") ? (
                <button
                  type="button"
                  onClick={() => {
                    removeCoupon();
                    setSubmitError(null);
                  }}
                  className={cx(smallLink, "mt-1 font-semibold")}
                >
                  Remover o cupom e continuar sem desconto
                </button>
              ) : null}
              {submitError.code === "OUT_OF_STOCK" ||
              submitError.code === "VARIANT_UNAVAILABLE" ||
              submitError.code === "NO_ACTIVE_PRICE" ? (
                <Link href="/carrinho" className={cx(smallLink, "mt-1 font-semibold")}>
                  Ajustar a sacola
                </Link>
              ) : null}
            </Notice>
          ) : null}

          {/* O fecho noir: total e o botão ouro. Nenhum input aqui dentro. */}
          <NoirStage
            as="div"
            className="rounded-(--radius-hair) px-5 py-6 sm:px-6 sm:py-7"
          >
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className={eyebrowNoir}>Total</p>
                <p className="mt-1 font-display text-title font-semibold text-gold-200 tabular-nums">
                  {formatCentsBRL(totalCents)}
                </p>
              </div>
              <button
                type="submit"
                disabled={submitting || quote.status === "loading"}
                className={cx(
                  btnGold,
                  "w-full sm:w-auto sm:min-w-64 disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {submitting ? "Fechando o pedido…" : "Fechar pedido"}
              </button>
            </div>
            <p className="mt-4 font-store text-xs leading-relaxed text-ivory-300">
              Ao fechar o pedido, você concorda com os{" "}
              <Link
                href="/termos"
                className="text-gold-300 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-200"
              >
                termos de compra
              </Link>
              .{" "}
              {paymentMethod === "cash"
                ? "Você paga em dinheiro na entrega."
                : "Pagamento online na sequência — ou combinado pelo WhatsApp."}
            </p>
          </NoirStage>
        </form>
      </div>
    </div>
  );
}
