"use client";

// Avisos de mensagem nova, no rodapé do usuário (lateral e gaveta):
// som e aviso de sistema valem para o painel aberto neste navegador; o
// aviso neste aparelho (Web Push) chega com o painel fechado. A permissão
// do navegador só é pedida quando você liga — nunca sozinha.
import { Bell } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useNotify } from "./use-notify";
import { type PushState, usePushSubscription } from "./use-push-subscription";

const emptySubscribe = () => () => {};

function readPermission(): "granted" | "denied" | "default" | "unsupported" {
  try {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  } catch {
    return "unsupported";
  }
}

const PUSH_HINT: Record<PushState, string> = {
  carregando: "Conferindo este aparelho…",
  sem_chave: "Avisos com o painel fechado ainda não estão configurados (chaves na Vercel).",
  indisponivel: "Este navegador não recebe avisos com o painel fechado.",
  precisa_instalar: "No iPhone: Compartilhar → Adicionar à Tela de Início, e ligue aqui dentro do app.",
  bloqueado: "O navegador bloqueou os avisos deste site — libere nas configurações dele.",
  desligado: "Chega mesmo com o painel fechado, neste aparelho — uma vez por conversa a cada 2 minutos.",
  ligando: "Pedindo permissão ao navegador…",
  ligado: "Ligado neste aparelho. Com o painel na tela, só o toast e o som avisam.",
};

export function NotifyPrefsMenu({ pushPublicKey }: { pushPublicKey: string | null }) {
  const { prefs, setPref } = useNotify();
  // Lido a cada render (o navegador pode ter mudado a permissão por fora).
  const permission = useSyncExternalStore(emptySubscribe, readPermission, () => "unsupported" as const);
  const push = usePushSubscription(pushPublicKey);
  const pushOn = push.state === "ligado" || push.state === "ligando";
  const pushDisabled = !["desligado", "ligado"].includes(push.state);

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
        <p className="mt-1 text-xs text-zinc-500">
          {permission === "denied"
            ? "O navegador bloqueou os avisos deste site — libere nas configurações dele."
            : permission === "unsupported"
              ? "Este navegador não mostra avisos de sistema."
              : "Com o painel aberto, em qualquer página. O aviso de sistema aparece quando a aba está escondida."}
        </p>
        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={pushOn}
            disabled={pushDisabled}
            onChange={(event) => void (event.target.checked ? push.enable() : push.disable())}
            className="size-4 accent-gold-400"
          />
          Aviso neste aparelho (painel fechado)
        </label>
        <p className="mt-1 text-xs text-zinc-500">{push.error ? `Não deu: ${push.error}.` : PUSH_HINT[push.state]}</p>
      </div>
    </details>
  );
}
