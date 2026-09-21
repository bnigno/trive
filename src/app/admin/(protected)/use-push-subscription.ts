"use client";

// Web Push deste aparelho: liga (permissão num toque + inscrição + POST),
// desliga, e ao abrir o painel confere se a inscrição ainda existe — o iOS
// descarta inscrições de app pouco usado; com a permissão já dada, reinscreve
// em silêncio e o servidor fica com o endpoint novo.
import { useCallback, useEffect, useState } from "react";

export type PushState =
  | "carregando"
  | "sem_chave"
  | "indisponivel"
  | "precisa_instalar"
  | "bloqueado"
  | "desligado"
  | "ligando"
  | "ligado";

const SW_URL = "/admin-sw.js";
// "/admin" (sem barra) cobre /admin e /admin/…: é onde o app instalado abre (start_url).
const SW_SCOPE = "/admin";
const API_URL = "/admin/push/subscriptions";
const WANTED_KEY = "trive.push";
const SYNCED_KEY = "trive.push.synced";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function readFlag(storage: Storage | undefined, key: string): boolean {
  try {
    return storage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(storage: Storage | undefined, key: string, on: boolean): void {
  try {
    if (on) storage?.setItem(key, "1");
    else storage?.removeItem(key);
  } catch {
    // Sem storage (modo privado): a preferência vive só nesta aba.
  }
}

function isIosNotInstalled(): boolean {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!ios) return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return !standalone;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return existing ?? (await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }));
}

function bytesToBase64Url(buffer: ArrayBuffer | null): string | null {
  if (!buffer) return null;
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A inscrição foi feita com a chave de HOJE? Chave trocada no servidor = inscrição inútil (401/403 para sempre). */
function subscribedWithKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = bytesToBase64Url(subscription.options.applicationServerKey);
  return current === null || current === publicKey.replace(/=+$/, "");
}

async function currentSubscription(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription | null> {
  const subscription = await reg.pushManager.getSubscription();
  if (subscription && !subscribedWithKey(subscription, publicKey)) {
    await subscription.unsubscribe();
    return null;
  }
  return subscription;
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...subscription.toJSON(), userAgent: navigator.userAgent }),
  });
  if (!response.ok) throw new Error(`inscrição não gravada (${response.status})`);
}

export function usePushSubscription(publicKey: string | null): {
  state: PushState;
  error: string | null;
  enable(): Promise<void>;
  disable(): Promise<void>;
} {
  const [state, setState] = useState<PushState>("carregando");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const settle = (next: PushState) => {
      if (!disposed) setState(next);
    };
    const probe = async () => {
      if (!publicKey) return settle("sem_chave");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return settle(isIosNotInstalled() ? "precisa_instalar" : "indisponivel");
      }
      if (Notification.permission === "denied") return settle("bloqueado");
      try {
        const reg = await registration();
        let subscription = await currentSubscription(reg, publicKey);
        const wanted = readFlag(window.localStorage, WANTED_KEY);
        if (!subscription && wanted && Notification.permission === "granted") {
          subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
          await saveSubscription(subscription);
        } else if (subscription && !readFlag(window.sessionStorage, SYNCED_KEY)) {
          // Uma vez por sessão: o servidor reencontra o endpoint (ou o usuário
          // que está logado agora neste navegador).
          await saveSubscription(subscription);
          writeFlag(window.sessionStorage, SYNCED_KEY, true);
        }
        settle(subscription ? "ligado" : "desligado");
      } catch {
        settle("desligado");
      }
    };
    void probe();
    return () => {
      disposed = true;
    };
  }, [publicKey]);

  const enable = useCallback(async () => {
    if (!publicKey) return;
    setError(null);
    setState("ligando");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "bloqueado" : "desligado");
        return;
      }
      const reg = await registration();
      const subscription =
        (await currentSubscription(reg, publicKey)) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      await saveSubscription(subscription);
      writeFlag(window.localStorage, WANTED_KEY, true);
      writeFlag(window.sessionStorage, SYNCED_KEY, true);
      setState("ligado");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "não foi possível ligar");
      setState("desligado");
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setError(null);
    writeFlag(window.localStorage, WANTED_KEY, false);
    try {
      const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) {
        await fetch(API_URL, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "não foi possível desligar");
    }
    setState("desligado");
  }, []);

  return { state, error, enable, disable };
}
