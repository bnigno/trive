// Service worker do painel (escopo /admin): recebe o Web Push e mostra o
// aviso. Com uma janela do painel visível, o toast e o bipe dela já avisaram:
// a notificação sai SILENCIOSA (sem som nem vibração) — some navegador exige
// que todo push vire notificação (Safari revoga a inscrição, Chrome mostra
// um aviso genérico) e por isso nunca fica mudo de todo. JS puro, sem build.
/* global self, clients */

const ADMIN_PATH = "/admin";
const DEFAULT_URL = "/admin/whatsapp/conversas";
const ICON = "/brand/icon-192.png";

function isAdminWindow(client) {
  try {
    return new URL(client.url).pathname.startsWith(ADMIN_PATH);
  } catch {
    return false;
  }
}

async function adminWindowVisible() {
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  return windows.some((client) => isAdminWindow(client) && client.visibilityState === "visible");
}

function readPayload(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (!data || typeof data.title !== "string" || data.title === "") return null;
    return {
      title: data.title,
      body: typeof data.body === "string" ? data.body : undefined,
      url: typeof data.url === "string" && data.url.startsWith(ADMIN_PATH) ? data.url : DEFAULT_URL,
      tag: typeof data.tag === "string" && data.tag !== "" ? data.tag : "trive-wa",
    };
  } catch {
    return null;
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  const payload = readPayload(event);
  if (!payload) return;
  event.waitUntil(
    (async () => {
      const quiet = await adminWindowVisible();
      await self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        renotify: !quiet,
        silent: quiet,
        icon: ICON,
        badge: ICON,
        data: { url: payload.url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || DEFAULT_URL;
  event.waitUntil(
    (async () => {
      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find(isAdminWindow);
      if (existing) {
        try {
          const focused = await existing.focus();
          // navigate() só vale para janela controlada por este SW; fora dela, abre outra.
          await (focused || existing).navigate(url);
          return;
        } catch {
          // segue para openWindow
        }
      }
      await clients.openWindow(url);
    })(),
  );
});

// O navegador trocou a inscrição por conta própria: reinscreve com a mesma
// chave e avisa o servidor, senão o aviso some em silêncio.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const applicationServerKey = old && old.options ? old.options.applicationServerKey : undefined;
      if (!applicationServerKey) return;
      const next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await fetch("/admin/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...next.toJSON(), userAgent: self.navigator ? self.navigator.userAgent : null }),
      });
    })(),
  );
});
