// O service worker do painel, rodado num `self` de mentira: com uma janela
// do painel visível o push fica mudo (o painel já avisou); sem janela, mostra
// o aviso com o tag da conversa; o toque abre/foca a conversa.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

type Listener = (event: Record<string, unknown>) => unknown;

function loadServiceWorker(windows: Array<{ url: string; visibilityState: string; focus?: () => Promise<void>; navigate?: (url: string) => Promise<void> }>) {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const clients = {
    matchAll: async () => windows,
    claim: async () => undefined,
    openWindow: async (url: string) => {
      opened.push(url);
    },
  };
  const self = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients,
  };
  runInNewContext(readFileSync("public/admin-sw.js", "utf8"), { self, clients, URL, fetch: async () => undefined });
  const dispatch = async (name: string, event: Record<string, unknown>) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(name)?.({ ...event, waitUntil: (promise: Promise<unknown>) => (pending = promise) });
    await pending;
  };
  return { dispatch, shown, opened };
}

const payload = { title: "Nova mensagem de Ana", body: "tem em M?", url: "/admin/whatsapp/conversas?c=abc", tag: "abc" };
const pushEvent = (data: unknown) => ({ data: { json: () => data } });

describe("public/admin-sw.js", () => {
  it("painel visível na tela: a notificação sai silenciosa (o toast e o bipe do painel já avisaram)", async () => {
    const sw = loadServiceWorker([{ url: "https://trivemaison.com.br/admin/pedidos", visibilityState: "visible" }]);
    await sw.dispatch("push", pushEvent(payload));
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0].options).toMatchObject({ silent: true, renotify: false, tag: "abc" });
  });

  it("painel escondido ou fechado: mostra com som, o tag da conversa e a url para o toque", async () => {
    const sw = loadServiceWorker([{ url: "https://trivemaison.com.br/admin/pedidos", visibilityState: "hidden" }]);
    await sw.dispatch("push", pushEvent(payload));
    expect(sw.shown).toEqual([
      { title: "Nova mensagem de Ana", options: expect.objectContaining({ body: "tem em M?", tag: "abc", silent: false, renotify: true, data: { url: "/admin/whatsapp/conversas?c=abc" } }) },
    ]);
    // A loja aberta numa aba não conta como painel.
    const store = loadServiceWorker([{ url: "https://trivemaison.com.br/produto/x", visibilityState: "visible" }]);
    await store.dispatch("push", pushEvent(payload));
    expect(store.shown[0].options).toMatchObject({ silent: false });
  });

  it("payload estranho (sem título, url fora do painel, não-JSON) não derruba nem abre link de fora", async () => {
    const sw = loadServiceWorker([]);
    await sw.dispatch("push", pushEvent({ body: "sem título" }));
    await sw.dispatch("push", { data: { json: () => { throw new Error("não é json"); } } });
    expect(sw.shown).toEqual([]);
    await sw.dispatch("push", pushEvent({ ...payload, url: "https://outro-site.example/x", tag: "" }));
    expect(sw.shown[0].options).toMatchObject({ tag: "trive-wa", data: { url: "/admin/whatsapp/conversas" } });
  });

  it("toque no aviso: foca a janela do painel que já existe e navega; sem janela, abre uma", async () => {
    const focused: string[] = [];
    const navigated: string[] = [];
    const sw = loadServiceWorker([{ url: "https://trivemaison.com.br/admin", visibilityState: "hidden", focus: async () => { focused.push("ok"); }, navigate: async (url) => { navigated.push(url); } }]);
    const notification = { close: () => undefined, data: { url: "/admin/whatsapp/conversas?c=abc" } };
    await sw.dispatch("notificationclick", { notification });
    expect(focused).toEqual(["ok"]);
    expect(navigated).toEqual(["/admin/whatsapp/conversas?c=abc"]);
    expect(sw.opened).toEqual([]);

    const empty = loadServiceWorker([]);
    await empty.dispatch("notificationclick", { notification });
    expect(empty.opened).toEqual(["/admin/whatsapp/conversas?c=abc"]);

    // Janela do painel fora do escopo do SW (navigate() recusa): abre outra em vez de só focar.
    const uncontrolled = loadServiceWorker([{ url: "https://trivemaison.com.br/admin", visibilityState: "hidden", focus: async () => undefined, navigate: async () => { throw new TypeError("not controlled"); } }]);
    await uncontrolled.dispatch("notificationclick", { notification });
    expect(uncontrolled.opened).toEqual(["/admin/whatsapp/conversas?c=abc"]);
  });
});
