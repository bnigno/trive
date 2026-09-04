"use client";

// Enquanto o WhatsApp está desconectado, o QR da Z-API expira em segundos:
// recarrega a página (dados do servidor) a cada 20 s para o código ficar
// sempre válido, sem o dono clicar em "Atualizar".
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const INTERVAL_MS = 20_000;

export function QrAutoRefresh({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      router.refresh();
      setTick((value) => value + 1);
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  return (
    <div className="flex flex-col gap-2">
      {children}
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400" aria-live="polite">
        O código renova sozinho a cada 20 segundos{tick > 0 ? ` (renovado ${tick}×)` : ""}.
      </p>
    </div>
  );
}
