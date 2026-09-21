"use client";

// Som e aviso de sistema das mensagens novas, no rodapé do usuário (lateral
// e gaveta): valem para o painel inteiro neste navegador. A permissão do
// navegador só é pedida quando você liga o aviso de sistema — nunca sozinha.
import { Bell } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useNotify } from "./use-notify";

const emptySubscribe = () => () => {};

function readPermission(): "granted" | "denied" | "default" | "unsupported" {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

export function NotifyPrefsMenu() {
  const { prefs, setPref } = useNotify();
  // Lido a cada render (o navegador pode ter mudado a permissão por fora).
  const permission = useSyncExternalStore(emptySubscribe, readPermission, () => "unsupported" as const);

  // O painel ancora no rodapé (o pai `relative`), não no sino: a lateral tem
  // 256 px e um painel preso ao ícone sairia pela esquerda.
  return (
    <details>
      <summary
        aria-label="Avisos de mensagem nova"
        title="Avisos de mensagem nova"
        className="grid size-8 cursor-pointer list-none place-items-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-400/60 motion-reduce:transition-none [&::-webkit-details-marker]:hidden"
      >
        <Bell aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </summary>
      <div className="absolute bottom-full left-3 right-3 z-40 mb-1 rounded-xl border border-white/10 bg-noir-900 p-3 text-sm text-zinc-200 shadow-lg">
        <p className="font-medium text-zinc-100">Mensagem nova no WhatsApp</p>
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.sound}
            onChange={(event) => setPref("sound", event.target.checked)}
            className="size-4 accent-gold-400"
          />
          Som
        </label>
        <label className="mt-1.5 flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.desktop}
            disabled={permission === "unsupported" || permission === "denied"}
            onChange={(event) => setPref("desktop", event.target.checked)}
            className="size-4 accent-gold-400"
          />
          Aviso na área de trabalho
        </label>
        <p className="mt-2 text-xs text-zinc-500">
          {permission === "denied"
            ? "O navegador bloqueou os avisos deste site — libere nas configurações dele."
            : permission === "unsupported"
              ? "Este navegador não mostra avisos de sistema."
              : "Valem em qualquer página do painel, neste navegador. O aviso de sistema aparece quando a aba está escondida."}
        </p>
      </div>
    </details>
  );
}
