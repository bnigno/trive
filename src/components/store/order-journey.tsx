// Linha do tempo do pedido na página pública: uma lista vertical no papel da
// maison, cada passo com a hora em que aconteceu; o passo "Embalado" mostra a
// foto real do pacote e o "Enviado" o código de rastreio. Server Component
// puro — os passos vêm prontos de buildOrderJourney (core).
import type { JourneyStep } from "@/core/orders/journey";
import { IconCheck } from "@/components/store/icons";
import { cx } from "@/components/ui/cx";

const dateFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
});

function formatAt(date: Date): string {
  return `${dateFmt.format(date)} às ${timeFmt.format(date)}`;
}

export function OrderJourney({
  steps,
  packagePhotoUrl,
  deliveredPhotoUrl = null,
  trackingCode,
}: {
  steps: JourneyStep[];
  /** URL pública da foto do pacote, quando o dono já embalou. */
  packagePhotoUrl: string | null;
  /** URL pública da foto da entrega, quando a dona registrou a entrega com foto. */
  deliveredPhotoUrl?: string | null;
  trackingCode: string | null;
}) {
  return (
    <ol className="mt-5 flex flex-col" aria-label={`Andamento do pedido, ${steps.length} etapas`}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const showPhoto =
          step.key === "packed" && step.state !== "upcoming" && packagePhotoUrl !== null;
        const showDelivered = step.key === "delivered" && step.state === "done" && deliveredPhotoUrl !== null;
        const showTracking =
          step.key === "shipped" && step.state !== "upcoming" && trackingCode !== null;
        return (
          <li
            key={step.key}
            className="relative flex gap-4 pb-6 last:pb-0"
            aria-current={step.state === "current" ? "step" : undefined}
          >
            {/* Trilho vertical entre as bolinhas: dourado até onde chegou. */}
            {!last ? (
              <span
                aria-hidden
                className={cx(
                  "absolute top-7 bottom-0 left-[13px] w-px",
                  step.state === "done" ? "bg-gold-500" : "bg-ivory-300",
                )}
              />
            ) : null}
            <span
              aria-hidden
              className={cx(
                "relative z-10 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                step.state === "current" && "bg-ink-950 text-gold-300",
                step.state === "done" && "border border-gold-500 bg-ivory-50",
                step.state === "upcoming" && "border border-ivory-300 bg-ivory-50 text-ink-400",
              )}
            >
              {step.state === "current" ? (
                <span className="absolute inset-0 animate-step-halo rounded-full ring-4 ring-gold-500/25 motion-reduce:animate-none" />
              ) : null}
              {step.state === "done" ? (
                <IconCheck className="h-3.5 w-3.5 text-gold-700" />
              ) : (
                index + 1
              )}
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p
                className={cx(
                  "font-store text-[13px] tracking-[0.08em] uppercase",
                  step.state === "current"
                    ? "font-medium text-ink-900"
                    : step.state === "done"
                      ? "text-ink-700"
                      : "text-ink-500",
                )}
              >
                {step.label}
                <span className="sr-only">
                  {step.state === "done"
                    ? ", concluído"
                    : step.state === "current"
                      ? ", etapa atual"
                      : ", a seguir"}
                </span>
              </p>
              {step.at ? (
                <p className="mt-0.5 font-store text-sm text-ink-500 tabular-nums">
                  {formatAt(step.at)}
                </p>
              ) : null}
              {showPhoto ? (
                <figure className="mt-3 max-w-xs">
                  {/* Foto tirada pelo dono; sem dado pessoal (aviso no painel). */}
                  <img
                    src={packagePhotoUrl}
                    alt="Foto do seu pacote, embalado na maison"
                    loading="lazy"
                    className="aspect-[4/5] w-full rounded-(--radius-hair) border border-ivory-300 object-cover"
                  />
                  <figcaption className="mt-2 font-display text-base text-ink-700 italic">
                    Sua peça, embalada com carinho.
                  </figcaption>
                </figure>
              ) : null}
              {step.detail ? (
                <p className="mt-0.5 font-store text-sm text-ink-700">{step.detail}</p>
              ) : null}
              {showDelivered ? (
                <figure className="mt-3 max-w-xs">
                  <img
                    src={deliveredPhotoUrl as string}
                    alt="Foto da entrega do seu pedido"
                    loading="lazy"
                    className="aspect-[4/5] w-full rounded-(--radius-hair) border border-ivory-300 object-cover"
                  />
                  <figcaption className="mt-2 font-display text-base text-ink-700 italic">
                    Chegou até você.
                  </figcaption>
                </figure>
              ) : null}
              {showTracking ? (
                <p className="mt-1.5 font-store text-sm text-ink-700">
                  Rastreio:{" "}
                  <span className="font-mono text-ink-900">{trackingCode}</span>
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
