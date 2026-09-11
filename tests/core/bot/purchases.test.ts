// Histórico de compras para a vendedora (PURO): a ferramenta lista os últimos
// pedidos com status honesto; o caderninho só conta compra paga/entregue.
import { describe, expect, it } from "vitest";

import {
  formatPurchaseDate,
  isPurchasedStatus,
  NO_PURCHASES_TEXT,
  purchaseItemLabel,
  purchaseMemoryLine,
  summarizePurchaseHistory,
  type PurchaseOrderSummary,
} from "@/core/bot/purchases";
import { formatCentsBRL } from "@/lib/money";

const DUNAS: PurchaseOrderSummary = {
  orderNumber: 1013,
  status: "paid",
  // 23:30 UTC = 20:30 em São Paulo do mesmo dia; 02:30 UTC do dia 12 seria dia 11 em SP.
  createdAt: new Date("2026-09-11T23:30:00Z"),
  totalCents: 8799,
  items: [{ name: "Longo Dunas", variantLabel: "Areia · M", quantity: 1 }],
};
const CANECA: PurchaseOrderSummary = {
  orderNumber: 1002,
  status: "delivered",
  createdAt: new Date("2026-08-26T15:00:00Z"),
  totalCents: 6980,
  items: [{ name: "Caneca Azul", variantLabel: "", quantity: 2 }],
};
const CANCELADO: PurchaseOrderSummary = {
  orderNumber: 1012,
  status: "canceled",
  createdAt: new Date("2026-09-11T03:00:00Z"),
  totalCents: 8999,
  items: [{ name: "Longo Dunas", variantLabel: "Areia · M", quantity: 1 }],
};

describe("isPurchasedStatus", () => {
  it("pago, em preparação, enviado e entregue são compra; o resto não", () => {
    expect(["paid", "preparing", "shipped", "delivered"].every(isPurchasedStatus)).toBe(true);
    expect(["draft", "pending_payment", "canceled", "refunded", "x"].some(isPurchasedStatus)).toBe(false);
  });
});

describe("formatPurchaseDate / purchaseItemLabel", () => {
  it("data no dia de São Paulo e peça com quantidade e variação", () => {
    expect(formatPurchaseDate(new Date("2026-09-12T02:30:00Z"))).toBe("11/09/2026");
    expect(purchaseItemLabel(DUNAS.items[0])).toBe("1× Longo Dunas (Areia · M)");
    expect(purchaseItemLabel(CANECA.items[0])).toBe("2× Caneca Azul");
  });
});

describe("summarizePurchaseHistory", () => {
  it("sem pedidos: diz que é a primeira compra neste número, sem negar o cadastro", () => {
    expect(summarizePurchaseHistory([])).toBe(NO_PURCHASES_TEXT);
    expect(NO_PURCHASES_TEXT).toContain("primeira compra");
    expect(NO_PURCHASES_TEXT).toContain("Não diga que a loja não guarda cadastro");
  });

  it("uma linha por pedido, do jeito que veio, com status nas palavras da vendedora e nota interna", () => {
    const text = summarizePurchaseHistory([DUNAS, CANCELADO, CANECA]);
    expect(text).toContain("Pedidos desta cliente (os 3 mais recentes, do mais novo ao mais antigo):");
    expect(text).toContain(
      `• #1013 — 11/09/2026 — pagamento aprovado — ${formatCentsBRL(8799)}: 1× Longo Dunas (Areia · M)`,
    );
    expect(text).toContain(`• #1012 — 11/09/2026 — cancelado — ${formatCentsBRL(8999)}:`);
    expect(text).toContain(`• #1002 — 26/08/2026 — entregue — ${formatCentsBRL(6980)}: 2× Caneca Azul`);
    expect(text).toContain("[Só pedidos deste telefone. Peças pagas ou entregues");
  });

  it("só pedidos não pagos: a nota avisa que não é compra feita; um pedido só muda o cabeçalho", () => {
    const text = summarizePurchaseHistory([CANCELADO]);
    expect(text).toContain("Pedido desta cliente (o mais recente):");
    expect(text).toContain("[Só pedidos deste telefone. Nenhum deles foi pago: não trate como compra feita.]");
  });
});

describe("purchaseMemoryLine", () => {
  it("compra paga vira 'Compras anteriores' com contagem, número, data e peças", () => {
    expect(purchaseMemoryLine(DUNAS, 1)).toBe(
      "Compras anteriores: 1 compra — última #1013 (11/09/2026): 1× Longo Dunas (Areia · M)",
    );
    expect(purchaseMemoryLine(CANECA, 4)).toBe(
      "Compras anteriores: 4 compras — última #1002 (26/08/2026): 2× Caneca Azul",
    );
  });

  it("mais de 3 peças vira 'e mais N'", () => {
    const grande = {
      ...DUNAS,
      items: ["A", "B", "C", "D", "E"].map((name) => ({ name, variantLabel: "", quantity: 1 })),
    };
    expect(purchaseMemoryLine(grande, 1)).toContain(": 1× A, 1× B, 1× C e mais 2");
  });

  it("sem compra paga não há linha: nem cancelado, nem null, nem total zero", () => {
    expect(purchaseMemoryLine(CANCELADO, 1)).toBeNull();
    expect(purchaseMemoryLine(null, 0)).toBeNull();
    expect(purchaseMemoryLine(DUNAS, 0)).toBeNull();
  });
});
