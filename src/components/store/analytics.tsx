"use client";

// Único ponto de importação do Vercel Web Analytics (sem cookie, sem
// consentimento). Toda a vitrine registra eventos por trackStoreEvent — nomes
// em inglês, sem dado pessoal, valores em centavos inteiros.
import { track } from "@vercel/analytics";
import { Analytics, type BeforeSend } from "@vercel/analytics/next";

import { anonymizeAnalyticsUrl } from "@/lib/analytics-url";

const beforeSend: BeforeSend = (event) => ({ ...event, url: anonymizeAnalyticsUrl(event.url) });

export function StoreAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}

export type StoreEventName =
  | "product_view"
  | "add_to_cart"
  | "checkout_start"
  | "order_placed"
  | "style_quiz_done";

export function trackStoreEvent(
  name: StoreEventName,
  props?: Record<string, string | number | boolean>,
): void {
  try {
    track(name, props);
  } catch {
    // Analytics é melhor esforço: nunca derruba a loja.
  }
}
