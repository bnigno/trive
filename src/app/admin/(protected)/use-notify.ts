"use client";

import { useCallback, useSyncExternalStore } from "react";

export type NotifyPrefs = { sound: boolean; desktop: boolean };

export type NotifyInput = {
  kind: "handoff" | "inbound";
  title: string;
  body?: string;
  conversationId?: string;
};

const STORAGE_KEY = "trive.wa-notify";
const DEFAULT_PREFS: NotifyPrefs = { sound: true, desktop: false };

// AudioContext único do módulo, criado sob demanda no primeiro beep:
// navegadores limitam o número de contextos e o autoplay só libera áudio
// depois de um gesto do usuário — por isso o resume() a cada toque.
let audioCtx: AudioContext | null = null;

function playBeep(): void {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") {
      void audioCtx.resume();
    }
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.13);
  } catch {
    // Áudio indisponível: aviso sonoro é melhor-esforço.
  }
}

function readStoredPrefs(): NotifyPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const record = parsed as Record<string, unknown>;
    return {
      sound:
        typeof record.sound === "boolean" ? record.sound : DEFAULT_PREFS.sound,
      desktop:
        typeof record.desktop === "boolean"
          ? record.desktop
          : DEFAULT_PREFS.desktop,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

// Store de preferências compartilhado entre todas as instâncias do hook
// (sino do chat e badge da sidebar enxergam o mesmo estado). O snapshot é
// cacheado porque useSyncExternalStore exige referência estável.
let cachedPrefs: NotifyPrefs | null = null;
const prefsListeners = new Set<() => void>();

function getPrefsSnapshot(): NotifyPrefs {
  cachedPrefs ??= readStoredPrefs();
  return cachedPrefs;
}

function getServerPrefsSnapshot(): NotifyPrefs {
  return DEFAULT_PREFS;
}

function subscribePrefs(listener: () => void): () => void {
  prefsListeners.add(listener);
  return () => {
    prefsListeners.delete(listener);
  };
}

function setStoredPrefs(next: NotifyPrefs): void {
  cachedPrefs = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage indisponível (modo privado etc.): preferência vive só na aba.
  }
  for (const listener of prefsListeners) listener();
}

function openConversation(conversationId: string | undefined): void {
  try {
    window.focus();
    window.location.href = conversationId
      ? `/admin/whatsapp/conversas?c=${conversationId}`
      : "/admin/whatsapp/conversas";
  } catch {
    // Sem janela para focar: nada a fazer.
  }
}

export function useNotify(): {
  prefs: NotifyPrefs;
  setPref(key: "sound" | "desktop", value: boolean): void;
  notify(input: NotifyInput): void;
} {
  const prefs = useSyncExternalStore(
    subscribePrefs,
    getPrefsSnapshot,
    getServerPrefsSnapshot,
  );

  const setPref = useCallback((key: "sound" | "desktop", value: boolean) => {
    if (key === "desktop" && value) {
      // desktop=true só persiste se o navegador conceder a permissão.
      try {
        if (typeof Notification === "undefined") return;
        void Notification.requestPermission().then((permission) => {
          if (permission === "granted") {
            setStoredPrefs({ ...getPrefsSnapshot(), desktop: true });
          }
        });
      } catch {
        // API de Notification indisponível: mantém desligado.
      }
      return;
    }
    setStoredPrefs({ ...getPrefsSnapshot(), [key]: value });
  }, []);

  const notify = useCallback((input: NotifyInput) => {
    const current = getPrefsSnapshot();
    if (current.sound) playBeep();
    try {
      if (
        current.desktop &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted" &&
        document.hidden
      ) {
        const notification = new Notification(input.title, {
          body: input.body,
          tag: input.conversationId,
        });
        notification.onclick = () => {
          openConversation(input.conversationId);
          notification.close();
        };
      }
    } catch {
      // new Notification pode lançar (ex.: Android sem service worker):
      // segue sem o aviso de sistema.
    }
  }, []);

  return { prefs, setPref, notify };
}
