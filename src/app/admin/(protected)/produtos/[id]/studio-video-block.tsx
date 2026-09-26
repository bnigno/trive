// O bloco "Vídeo da peça" (só o dono vê): a foto no corpo que já está na
// peça vira um vídeo de 5 s para o Instagram. Nunca aparece na vitrine. A
// página chama os services; aqui só se apresenta.
import Link from "next/link";

import type { FileStorage } from "@/adapters/storage";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { usdCentsToBrlCents } from "@/core/studio/cost";
import { videoLabel } from "@/core/studio/labels";
import { isVideoInFlight, VIDEO_CAPTION_NOTICE } from "@/core/studio/video";
import { formatDateTimeSP } from "@/emails/templates";
import { formatCentsBRL } from "@/lib/money";
import type { StudioVideoPanel } from "@/services/studio-video";

import { MakeVideoButton, VideoActions, VideoAutoRefresh, VideoCaption } from "./studio-video-forms";

const DOWNLOAD_CLASS = "text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";

export function StudioVideoBlock({
  productId,
  panel,
  caption,
  configured,
  storage,
}: {
  productId: string;
  panel: StudioVideoPanel;
  caption: { caption: string | null; filename: string };
  configured: boolean;
  storage: FileStorage;
}) {
  const costLabel = formatCentsBRL(panel.estimate.brlCents);
  let blocker: { title: string; hint: string; href?: string; link?: string } | null = null;
  if (!panel.settings.enabled) {
    blocker = {
      title: "O vídeo da peça está desligado.",
      hint: `Ligue em Vendedora & WhatsApp (cartão Foto no corpo). Cada vídeo de 5 s custa ≈ ${costLabel}.`,
      href: "/admin/whatsapp",
      link: "Ir para Vendedora & WhatsApp",
    };
  } else if (!configured) {
    blocker = { title: "Falta a chave da FASHN na hospedagem.", hint: "Cadastre FASHN_API_KEY na Vercel. Até lá nenhum vídeo é feito." };
  } else if (panel.sources.length === 0) {
    blocker = {
      title: "Escolha uma foto no corpo primeiro.",
      hint: "O vídeo sai de uma foto no corpo que já está na peça.",
      href: "#foto-no-corpo",
      link: "Ir para Foto no corpo",
    };
  }

  const content = (
    <div className="flex flex-col gap-6">
      {blocker ? (
        <EmptyState
          title={blocker.title}
          hint={blocker.hint}
          action={
            blocker.href ? (
              <Link href={blocker.href} className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100">
                {blocker.link}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <section aria-label="Fotos que podem virar vídeo" className="flex flex-col gap-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Hoje: {panel.usedToday} de {panel.settings.dailyLimit} vídeo(s) do teto do dia. Cada um custa ≈ {costLabel} e leva uns 5 minutos.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {panel.sources.map((source) => (
              <div key={source.candidateId} className="flex flex-col gap-2">
                <img
                  src={storage.publicUrl(source.storagePath)}
                  alt={source.color ? `Foto no corpo — ${source.color}` : "Foto no corpo"}
                  className="aspect-[3/4] w-full rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                />
                <MakeVideoButton
                  candidateId={source.candidateId}
                  productId={productId}
                  costLabel={costLabel}
                  pending={panel.videos.some((video) => video.candidateId === source.candidateId && isVideoInFlight(video.status))}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {panel.videos.length > 0 ? (
        <section aria-label="Vídeos da peça" className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {panel.videos.map((video) => {
              const label = videoLabel(video);
              const ready = video.status === "done" && video.storagePath;
              return (
                <div key={video.id} className="flex flex-col gap-2">
                  {ready ? (
                    <video
                      controls
                      playsInline
                      preload="metadata"
                      poster={storage.publicUrl(video.sourceStoragePath)}
                      src={storage.publicUrl(video.storagePath as string)}
                      className="aspect-[3/4] w-full rounded-md border border-zinc-200 bg-black object-cover dark:border-zinc-700"
                    />
                  ) : (
                    <div className="flex aspect-[3/4] w-full items-center justify-center rounded-md border border-dashed border-zinc-300 p-3 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                      {label.label}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <Badge tone={label.tone}>{label.label}</Badge>
                    <span>{formatDateTimeSP(video.createdAt)}</span>
                    {video.color ? <span>· {video.color}</span> : null}
                    {video.usdCents > 0 ? <span>· ≈ {formatCentsBRL(usdCentsToBrlCents(video.usdCents))}</span> : null}
                  </div>
                  {ready ? (
                    <a href={storage.publicUrl(video.storagePath as string, { download: caption.filename })} className={DOWNLOAD_CLASS}>
                      Baixar vídeo
                    </a>
                  ) : null}
                  <VideoActions
                    videoId={video.id}
                    productId={productId}
                    canRefetch={video.canRefetch}
                    canDiscard={video.status === "done" || video.status === "failed"}
                  />
                </div>
              );
            })}
          </div>
          {panel.videos.some((video) => video.status === "done") ? <VideoCaption caption={caption.caption} notice={VIDEO_CAPTION_NOTICE} /> : null}
        </section>
      ) : null}
    </div>
  );

  return (
    <Card
      id="video"
      title="Vídeo da peça"
      description="A foto no corpo que já está na peça vira um vídeo de 5 s para o Reels. Nunca aparece na vitrine — no Instagram vai sempre com o aviso de imagem feita com IA."
    >
      {panel.inFlight ? <VideoAutoRefresh>{content}</VideoAutoRefresh> : content}
    </Card>
  );
}
