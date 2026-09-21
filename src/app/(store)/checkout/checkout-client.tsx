"use client";

// Checkout em uma tela — "o formulário" no papel timbrado da maison: o resumo
// (a folha) + o formulário em três seções numeradas, com as opções de entrega
// logo abaixo do CEP e o fecho noir com o total e o botão ouro. O total
// exibido aqui é só informativo — quem manda é o recálculo do servidor em
// createStoreOrder (expected* detecta qualquer divergência e o cliente
// confirma antes de seguir). A lógica de estado é a mesma da versão anterior.

import { trackStoreEvent } from "@/components/store/analytics";
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
import { CorreiosOnRequestNotice } from "@/components/store/order/correios-on-request";
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
} from "@/components/store/styles";
import { cx } from "@/components/ui/cx";
import { GIFT_MESSAGE_MAX, GIFT_RECIPIENT_MAX } from "@/core/gifts/types";
import { formatCep } from "@/lib/cep";
import { CEP_AUTOFILL_MESSAGES, useCepAutofill } from "@/components/forms/use-cep-autofill";
import { normalizeDocument } from "@/lib/document";
import { formatCentsBRL } from "@/lib/money";
import { toE164BR } from "@/lib/phone";
import { readStoredStyle } from "@/lib/style-storage";
import type { DeliveryOption } from "@/core/shipping/delivery-windows";
import { assessNeededBy, isValidNeededBy, OCCASION_MAX } from "@/core/shipping/needed-by";
import { writeStoredCep } from "@/lib/cep-storage";
import { readStoredCoupon, writeStoredCoupon } from "@/lib/coupon-storage";
import { spDayKey } from "@/lib/sp-day";
import { isWindowOptionKey, pickDefaultOptionKey } from "@/lib/checkout-options";
import type { CreateStoreOrderInput, PriceChange } from "@/services/store-orders";

import { quoteCouponAction, quoteShippingAction } from "../carrinho/actions";
import {
  placeOrderAction,
  lookupCepAction,
} from "./actions";

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
  | { status: "done"; options: DeliveryOption[]; whatsappUrl: string | null; sellerName: string; motoboyArea: string };

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

/** Por opção de entrega: "Chega até sexta 16/10, 4 dias antes" ou "Pode chegar só…". */
function NeededByVerdictLine({ option, neededBy }: { option: DeliveryOption; neededBy: string }) {
  const verdict = assessNeededBy(
    option.kind === "motoboy" ? { kind: "motoboy", dayKey: option.window.dayKey } : { kind: "correios", deliveryDaysMax: option.deliveryDaysMax },
    neededBy,
    new Date(),
  );
  return (
    <span className={cx("mt-0.5 block text-[13px]", verdict.fits ? "text-laurel-700" : "text-claret-700")}>
      {verdict.fits ? "✓ " : "✕ "}
      {verdict.label}
    </span>
  );
}

export function CheckoutClient({
  initialCepDigits,
  initialOptionKey,
  initialCouponCode,
}: {
  initialCepDigits: string;
  /** ?frete= da sacola: optionKey (uuid da faixa, ou uuid:dia:HH:MM no motoboy). */
  initialOptionKey: string;
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
  const [isGift, setIsGift] = useState(false);
  // Data marcada: "preciso até o dia X" — cada opção de entrega diz se chega a tempo.
  const [hasNeededBy, setHasNeededBy] = useState(false);
  const [neededBy, setNeededBy] = useState("");
  const [occasion, setOccasion] = useState("");
  // Relógio lido uma vez por montagem (o React Compiler não memoiza chamadas impuras no render).
  const [todayKey] = useState(() => spDayKey(new Date()));
  const neededByActive = hasNeededBy && isValidNeededBy(neededBy, todayKey) ? neededBy : null;
  const [giftMessage, setGiftMessage] = useState("");
  const [documentValue, setDocumentValue] = useState("");
  const [phoneValue, setPhoneValue] = useState("");
  const [cepValue, setCepValue] = useState(formatCep(initialCepDigits));
  // CEP completo → rua, bairro, cidade e UF se preenchem; o cursor vai ao número.
  const formRef = useRef<HTMLFormElement>(null);
  const cepAutofill = useCepAutofill(formRef, (cep) => lookupCepAction({ cep }));
  // Veio da sacola com o CEP já digitado: o endereço se preenche ao abrir.
  const autofilledOnMount = useRef(false);
  useEffect(() => {
    if (!mounted || autofilledOnMount.current) return;
    autofilledOnMount.current = true;
    trackStoreEvent("checkout_start", { items: items.length, subtotalCents });
    if (initialCepDigits.length === 8) cepAutofill.onCepChange(initialCepDigits);
  }, [mounted, initialCepDigits, cepAutofill, items.length, subtotalCents]);
  const [fieldErrors, setFieldErrors] = useState<{
    document?: string;
    phone?: string;
    cep?: string;
    neededBy?: string;
  }>({});

  // ----- Frete: re-cotado no servidor ao montar e quando CEP/itens mudam --
  const cepDigits = cepValue.replace(/\D/g, "");
  const itemsKey = items
    .map((line) => `${line.variantId}:${line.quantity}`)
    .join(",");
  const [quote, setQuote] = useState<QuoteState>({ status: "idle" });
  const [selectedOptionKey, setSelectedOptionKey] = useState(initialOptionKey || null);
  /** A janela escolhida na sacola sumiu da cotação (passou da hora-limite). */
  /** A escolha da sacola sumiu da lista: 'window' (janela do motoboy passou da hora-limite) ou 'option' (cotação dos Correios renovada/vencida). */
  const [choiceGone, setChoiceGone] = useState<"window" | "option" | null>(null);
  const [shippingCentsOverride, setShippingCentsOverride] = useState<number | null>(
    null,
  );
  const [, startQuote] = useTransition();
  const lastQuoteKeyRef = useRef<string | null>(null);
  // Sobe quando o servidor recusa a janela do motoboy (passou da hora-limite):
  // a lista é cotada de novo e a escolha cai numa opção válida.
  const [quoteNonce, setQuoteNonce] = useState(0);

  useEffect(() => {
    if (!mounted || items.length === 0) return;
    if (cepDigits.length !== 8) {
      // CEP incompleto: some com a cotação antiga e espere o CEP completo.
      lastQuoteKeyRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- limpa cotação quando o CEP fica incompleto (pós-hidratação)
      setQuote({ status: "idle" });
      return;
    }
    const key = `${cepDigits}|${itemsKey}|${quoteNonce}`;
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
        options: result.options,
        whatsappUrl: result.whatsappUrl,
        sellerName: result.sellerName,
        motoboyArea: result.motoboyArea,
      });
      writeStoredCep(cepDigits);
      setShippingCentsOverride(null);
      // A escolha da sacola pode sumir da lista entre a sacola e o checkout:
      // a janela de hoje passou da hora-limite, ou a cotação dos Correios foi
      // renovada (id novo) — a escolha cai na primeira opção e a cliente é
      // avisada (nunca troca de opção em silêncio).
      setSelectedOptionKey((current) => {
        const next = pickDefaultOptionKey(result.options, current);
        setChoiceGone(current !== null && next !== current ? (isWindowOptionKey(current) ? "window" : "option") : null);
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, cepDigits, itemsKey, quoteNonce]);

  // ----- Entrega escolhida (o cupom de frete grátis e o total dependem dela) -----
  const options = quote.status === "done" ? quote.options : [];
  const selectedQuote = options.find((o) => o.optionKey === selectedOptionKey) ?? null;
  const shippingCents =
    shippingCentsOverride ?? selectedQuote?.priceCents ?? null;

  // ----- Cupom: re-cotado no servidor ao montar e quando a sacola, a entrega
  // ou a identidade (CPF + telefone válidos) mudam — com CPF e telefone, o
  // servidor confirma as regras por cliente antes do "Fechar pedido".
  // O código vem da URL (?cupom=, vindo da sacola) ou, sem ela, do navegador
  // (link /c/CÓDIGO) — lido depois da hidratação, como o CEP.
  const [couponCode, setCouponCode] = useState<string | null>(
    initialCouponCode.trim() ? initialCouponCode.trim().toUpperCase() : null,
  );
  useEffect(() => {
    if (!mounted || initialCouponCode.trim()) return;
    const stored = readStoredCoupon();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- cupom guardado no navegador entra pós-hidratação
    if (stored) setCouponCode((current) => current ?? stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);
  const [appliedCoupon, setAppliedCoupon] = useState<{
    code: string;
    discountCents: number;
    freeShipping: boolean;
    shippingDiscountCents: number;
    pendingNotice: string | null;
    hint: string | null;
  } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [, startCouponQuote] = useTransition();
  const lastCouponKeyRef = useRef<string | null>(null);
  const couponIdentity = (() => {
    const doc = normalizeDocument(documentValue);
    const phone = toE164BR(phoneValue);
    return doc && phone ? { document: doc.digits, phone } : null;
  })();
  const couponShipping =
    selectedQuote && shippingCents !== null ? { cents: shippingCents, kind: selectedQuote.kind } : null;

  useEffect(() => {
    if (!mounted || items.length === 0) return;
    if (!couponCode) {
      lastCouponKeyRef.current = null;
      return;
    }
    const key = [
      couponCode,
      itemsKey,
      couponShipping ? `${couponShipping.kind}:${couponShipping.cents}` : "",
      couponIdentity ? `${couponIdentity.document}:${couponIdentity.phone}` : "",
    ].join("|");
    if (lastCouponKeyRef.current === key) return;
    lastCouponKeyRef.current = key;
    startCouponQuote(async () => {
      const result = await quoteCouponAction({
        code: couponCode,
        items: items.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
        })),
        shipping: couponShipping,
        customer: couponIdentity,
      });
      // Resposta de uma cotação antiga (CPF corrigido enquanto a anterior
      // voava) não pode sobrescrever a atual.
      if (lastCouponKeyRef.current !== key) return;
      if (result.ok) {
        setAppliedCoupon({
          code: result.code,
          discountCents: result.discountCents,
          freeShipping: result.freeShipping,
          shippingDiscountCents: result.shippingDiscountCents,
          pendingNotice: result.pendingNotice,
          hint: result.hint,
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
  }, [mounted, couponCode, itemsKey, couponShipping?.kind, couponShipping?.cents, couponIdentity?.document, couponIdentity?.phone]);

  function removeCoupon() {
    writeStoredCoupon(null);
    setCouponCode(null);
    setAppliedCoupon(null);
    setCouponError(null);
  }

  // Resumo compacto no celular: a partir de 4 peças, as demais ficam
  // dobradas até "Ver as N peças".
  const [expanded, setExpanded] = useState(false);

  const discountCents = appliedCoupon?.discountCents ?? 0;
  // Frete cobrado = preço da opção − o que o cupom de frete grátis perdoa.
  const shippingDiscountCents =
    shippingCents === null ? 0 : Math.min(appliedCoupon?.shippingDiscountCents ?? 0, shippingCents);
  const chargedShippingCents = shippingCents === null ? null : shippingCents - shippingDiscountCents;
  const totalCents = subtotalCents - discountCents + (chargedShippingCents ?? 0);

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
          trackStoreEvent("order_placed", {
            orderNumber: result.orderNumber,
            paymentMethod: payload.paymentMethod ?? "online",
          });
          clear();
          // O cupom foi gasto com o pedido: a próxima sacola começa sem ele.
          writeStoredCoupon(null);
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
        // A escolha não serve mais (janela passou, cotação dos Correios venceu ou a faixa sumiu): recota e a seleção cai numa opção válida.
        if (
          result.code === "DELIVERY_WINDOW_EXPIRED" ||
          result.code === "DELIVERY_WINDOW_REQUIRED" ||
          result.code === "SHIPPING_QUOTE_STALE" ||
          result.code === "SHIPPING_RATE_UNAVAILABLE"
        ) {
          setQuoteNonce((n) => n + 1);
        }
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
    // Data marcada: com a caixa marcada, o dia precisa existir e ser hoje ou depois (relógio de agora, não o da abertura da página).
    if (hasNeededBy && !isValidNeededBy(neededBy, spDayKey(new Date()))) {
      errors.neededBy = neededBy ? "Escolha hoje ou um dia que ainda vem." : "Informe até que dia você precisa da peça.";
    }
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
        message:
          quote.status === "done" && quote.options.length === 0
            ? `Para este CEP o frete é calculado pela nossa equipe: fale com a ${quote.sellerName} pelo botão em Entrega para fechar o pedido.`
            : "Escolha uma opção de entrega para continuar.",
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
      ...(selectedQuote.kind === "motoboy" ? { deliveryWindow: selectedQuote.window } : {}),
      paymentMethod,
      ...(couponCode ? { couponCode } : {}),
      ...(readStoredStyle()?.token ? { styleToken: readStoredStyle()?.token } : {}),
      ...(isGift
        ? {
            gift: {
              recipientName: String(form.get("giftRecipientName") ?? "").trim(),
              ...(giftMessage.trim() ? { message: giftMessage.trim() } : {}),
            },
          }
        : {}),
      ...(neededByActive ? { neededBy: neededByActive, ...(occasion.trim() ? { occasion: occasion.trim() } : {}) } : {}),
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
            shippingCents={chargedShippingCents}
            shippingFallback="—"
            shippingNote={shippingDiscountCents > 0 ? "Frete grátis pelo cupom" : undefined}
            totalCents={totalCents}
          />
          {appliedCoupon?.freeShipping && discountCents === 0 ? (
            <p className="mt-2 flex items-center gap-3 font-store text-xs text-laurel-700">
              <span>Cupom {appliedCoupon.code}: frete grátis.</span>
              <button type="button" onClick={removeCoupon} className={cx(smallLink, "text-ink-700 hover:text-claret-700")}>
                remover cupom
              </button>
            </p>
          ) : null}
          {appliedCoupon?.hint ? (
            <p className="mt-2 font-store text-xs text-gold-800">{appliedCoupon.hint}</p>
          ) : null}
          {appliedCoupon?.pendingNotice ? (
            <p className="mt-2 font-store text-xs text-ink-500">{appliedCoupon.pendingNotice}</p>
          ) : null}
          <p className="mt-2 font-store text-xs text-ink-500">
            O total é confirmado pelo servidor no envio do pedido.
          </p>
        </Sheet>

        {/* O formulário */}
        <form
          ref={formRef}
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
                  onChange={(event) => {
                    const next = formatCep(event.target.value);
                    setCepValue(next);
                    cepAutofill.onCepChange(next);
                  }}
                  aria-invalid={fieldErrors.cep ? true : undefined}
                  className={inputClasses}
                />
                {cepAutofill.status !== "idle" ? (
                  <p className="mt-1 font-store text-xs text-ink-500" role="status">
                    {CEP_AUTOFILL_MESSAGES[cepAutofill.status]}
                  </p>
                ) : null}
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
                {quote.status === "done" && options.length === 0 ? (
                  <CorreiosOnRequestNotice
                    cepDigits={cepDigits}
                    motoboyArea={quote.motoboyArea}
                    sellerName={quote.sellerName}
                    fallbackUrl={quote.whatsappUrl}
                    items={items.map((line) => ({ variantId: line.variantId, sku: line.sku, quantity: line.quantity }))}
                  />
                ) : null}
                {choiceGone && options.length > 0 ? (
                  <Notice tone="gold" role="alert">
                    {choiceGone === "window"
                      ? "O horário de entrega que você escolheu na sacola já passou da hora-limite. Confira a opção marcada abaixo ou escolha outra."
                      : "A opção de entrega que você escolheu na sacola foi atualizada. Confira a opção marcada abaixo ou escolha outra."}
                  </Notice>
                ) : null}
                {options.length > 0 ? (
                  <fieldset>
                    <legend className={cx(eyebrow, "mb-2")}>Opções de entrega</legend>
                    <div className="space-y-2">
                      {options.map((option) => (
                        <OptionCard
                          key={option.optionKey}
                          name="shippingOption"
                          value={option.optionKey}
                          checked={selectedOptionKey === option.optionKey}
                          onChange={() => {
                            setSelectedOptionKey(option.optionKey);
                            setShippingCentsOverride(null);
                            setChoiceGone(null);
                          }}
                          title={option.name}
                          detail={
                            neededByActive ? (
                              <>
                                {deliveryLabel(option)}
                                <NeededByVerdictLine option={option} neededBy={neededByActive} />
                              </>
                            ) : (
                              deliveryLabel(option)
                            )
                          }
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
                    {options.some((option) => option.kind === "correios") ? (
                      <p className="mt-2 font-store text-xs text-ink-500">Correios: prazo em dias úteis, contado a partir da postagem.</p>
                    ) : null}
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

          <FormSection id="presente-title" number="03" title="É um presente?">
            <label className="flex min-h-11 cursor-pointer items-start gap-3 font-store text-sm text-ink-700">
              <input
                type="checkbox"
                name="isGift"
                checked={isGift}
                onChange={(event) => setIsGift(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-gold-600"
              />
              <span>
                Sim, é para presentear alguém. Enviamos{" "}
                <strong className="font-medium text-espresso-900">sem preço na embalagem</strong>,
                com um bilhete impresso na tipografia da TRIVÉ.
              </span>
            </label>
            {isGift ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="Para quem é" hint="O nome vai no bilhete." className="sm:col-span-2">
                  <input
                    name="giftRecipientName"
                    required
                    maxLength={GIFT_RECIPIENT_MAX}
                    autoComplete="off"
                    className={inputClasses}
                  />
                </Field>
                <Field
                  label="Bilhete (opcional)"
                  hint={`${giftMessage.length}/${GIFT_MESSAGE_MAX} · sem emojis — impresso com a tipografia da TRIVÉ`}
                  className="sm:col-span-2"
                >
                  <textarea
                    name="giftMessage"
                    rows={4}
                    maxLength={GIFT_MESSAGE_MAX}
                    value={giftMessage}
                    onChange={(event) => setGiftMessage(event.target.value)}
                    className={cx(inputClasses, "min-h-24 resize-y")}
                  />
                </Field>
              </div>
            ) : null}
          </FormSection>

          <FormSection id="data-title" number="04" title="É para uma data?">
            <label className="flex min-h-11 cursor-pointer items-start gap-3 font-store text-sm text-ink-700">
              <input
                type="checkbox"
                name="hasNeededBy"
                checked={hasNeededBy}
                onChange={(event) => setHasNeededBy(event.target.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 accent-gold-600"
              />
              <span>
                Sim, preciso da peça até um dia. Mostramos, em cada opção de entrega,{" "}
                <strong className="font-medium text-espresso-900">se chega a tempo</strong> — e a TRIVÉ prioriza a saída.
              </span>
            </label>
            {hasNeededBy ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="Até o dia" error={fieldErrors.neededBy} hint="Confira a opção de entrega acima: ela diz se chega.">
                  <input
                    name="neededBy"
                    type="date"
                    min={todayKey}
                    value={neededBy}
                    onChange={(event) => setNeededBy(event.target.value)}
                    required
                    aria-invalid={fieldErrors.neededBy ? true : undefined}
                    className={inputClasses}
                  />
                </Field>
                <Field label="Ocasião (opcional)" hint={`${occasion.length}/${OCCASION_MAX} · ex.: aniversário da mãe, Círio`}>
                  <input
                    name="occasion"
                    maxLength={OCCASION_MAX}
                    value={occasion}
                    onChange={(event) => setOccasion(event.target.value)}
                    autoComplete="off"
                    className={inputClasses}
                  />
                </Field>
              </div>
            ) : null}
          </FormSection>

          <FormSection id="pagamento-title" number="05" title="Pagamento">
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
