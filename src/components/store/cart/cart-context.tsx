"use client";

// Carrinho da loja (client-only): estado em React + persistência em
// localStorage ('trive-cart-v1'). Este arquivo é o DONO do contrato do
// carrinho — os demais componentes da loja importam exatamente daqui.
//
// Hidratação segura: o render inicial (servidor e primeiro paint do cliente)
// SEMPRE mostra 0 itens; o localStorage só é lido em useEffect, evitando
// mismatch de hidratação. Todo acesso ao localStorage fica em try/catch
// (Safari em modo privado, storage cheio, cookies bloqueados etc.).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface CartItemInput {
  variantId: string;
  name: string;
  sku: string;
  slug: string;
  /** Ex.: "Cor: Preto · Tamanho: M". */
  attributesLabel?: string;
  priceCents: number;
  imageUrl?: string;
  /** Estoque disponível no momento em que o item foi visto na vitrine. */
  availableQty: number;
}

export type CartLine = CartItemInput & { quantity: number };

export interface CartContextValue {
  items: CartLine[];
  /** Soma das quantidades de todos os itens. */
  count: number;
  subtotalCents: number;
  addItem: (input: CartItemInput, qty?: number) => void;
  setQuantity: (variantId: string, qty: number) => void;
  removeItem: (variantId: string) => void;
  clear: () => void;
  updatePrices: (changes: { variantId: string; newPriceCents: number }[]) => void;
}

const STORAGE_KEY = "trive-cart-v1";

const CartContext = createContext<CartContextValue | null>(null);

/** Aceita apenas linhas com o formato esperado — dados corrompidos são descartados. */
function sanitizeLines(value: unknown): CartLine[] {
  if (!Array.isArray(value)) return [];
  const lines: CartLine[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.variantId !== "string" ||
      line.variantId.length === 0 ||
      typeof line.name !== "string" ||
      typeof line.sku !== "string" ||
      typeof line.slug !== "string" ||
      typeof line.priceCents !== "number" ||
      !Number.isSafeInteger(line.priceCents) ||
      line.priceCents < 0 ||
      typeof line.availableQty !== "number" ||
      !Number.isSafeInteger(line.availableQty) ||
      typeof line.quantity !== "number" ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity <= 0 ||
      seen.has(line.variantId)
    ) {
      continue;
    }
    seen.add(line.variantId);
    lines.push({
      variantId: line.variantId,
      name: line.name,
      sku: line.sku,
      slug: line.slug,
      attributesLabel:
        typeof line.attributesLabel === "string" ? line.attributesLabel : undefined,
      priceCents: line.priceCents,
      imageUrl: typeof line.imageUrl === "string" ? line.imageUrl : undefined,
      availableQty: Math.max(0, line.availableQty),
      quantity: line.quantity,
    });
  }
  return lines;
}

function readStorage(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizeLines(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeStorage(items: CartLine[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Sem storage disponível: o carrinho segue vivo só em memória.
  }
}

/** Quantidade sempre entre 1 e o estoque disponível conhecido (mínimo 1). */
function clampQty(qty: number, availableQty: number): number {
  const max = Math.max(1, availableQty);
  return Math.min(Math.max(1, Math.trunc(qty)), max);
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartLine[]>([]);
  const hydratedRef = useRef(false);

  // Hidratação: carrega do localStorage só no cliente, após o primeiro paint.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hidratação do localStorage só no cliente (padrão SSR-safe)
    setItems(readStorage());
    hydratedRef.current = true;

    // Sincroniza entre abas: outra aba mexeu no carrinho → refletimos aqui.
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setItems(readStorage());
    };
    try {
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    } catch {
      return;
    }
  }, []);

  // Persiste após qualquer mutação — nunca antes de hidratar, para não
  // sobrescrever o carrinho salvo com o estado inicial vazio.
  useEffect(() => {
    if (!hydratedRef.current) return;
    writeStorage(items);
  }, [items]);

  const addItem = useCallback((input: CartItemInput, qty = 1) => {
    setItems((current) => {
      const existing = current.find((line) => line.variantId === input.variantId);
      if (existing) {
        // Reaproveita a linha, atualizando dados vindos da vitrine (preço,
        // estoque, imagem) — a fonte mais recente é sempre a mais confiável.
        return current.map((line) =>
          line.variantId === input.variantId
            ? {
                ...input,
                quantity: clampQty(line.quantity + qty, input.availableQty),
              }
            : line,
        );
      }
      return [...current, { ...input, quantity: clampQty(qty, input.availableQty) }];
    });
  }, []);

  const setQuantity = useCallback((variantId: string, qty: number) => {
    setItems((current) => {
      if (qty <= 0) return current.filter((line) => line.variantId !== variantId);
      return current.map((line) =>
        line.variantId === variantId
          ? { ...line, quantity: clampQty(qty, line.availableQty) }
          : line,
      );
    });
  }, []);

  const removeItem = useCallback((variantId: string) => {
    setItems((current) => current.filter((line) => line.variantId !== variantId));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  const updatePrices = useCallback(
    (changes: { variantId: string; newPriceCents: number }[]) => {
      if (changes.length === 0) return;
      const byVariant = new Map(
        changes.map((change) => [change.variantId, change.newPriceCents]),
      );
      setItems((current) =>
        current.map((line) => {
          const newPrice = byVariant.get(line.variantId);
          return newPrice === undefined ? line : { ...line, priceCents: newPrice };
        }),
      );
    },
    [],
  );

  const value = useMemo<CartContextValue>(() => {
    const count = items.reduce((sum, line) => sum + line.quantity, 0);
    const subtotalCents = items.reduce(
      (sum, line) => sum + line.priceCents * line.quantity,
      0,
    );
    return {
      items,
      count,
      subtotalCents,
      addItem,
      setQuantity,
      removeItem,
      clear,
      updatePrices,
    };
  }, [items, addItem, setQuantity, removeItem, clear, updatePrices]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error(
      "useCart precisa de um <CartProvider> acima na árvore (layout da loja).",
    );
  }
  return context;
}
