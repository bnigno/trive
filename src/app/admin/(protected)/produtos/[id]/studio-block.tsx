// O bloco "Foto no corpo" da peça (só o dono vê): estado do recurso, o
// formulário do pedido e os pedidos recentes com as candidatas. A página
// chama os services; aqui só se apresenta.
import Link from "next/link";

import { isImageStudioConfigured } from "@/adapters/image-studio";
import type { FileStorage } from "@/adapters/storage";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { parsePieceType } from "@/core/catalog/piece-types";
import { candidateLabel, requestLabel } from "@/core/studio/labels";
import { BODY_SIZES, HOUSE_MODELS, SCENE_PRESETS } from "@/core/studio/presets";
import { garmentCategoryFor } from "@/core/studio/prompts";
import { estimateRequestUsdCents, usdCentsToBrlCents } from "@/core/studio/cost";
import { formatDateTimeSP } from "@/emails/templates";
import { formatCentsBRL } from "@/lib/money";
import type { StudioBasePhoto, StudioRequestView, StudioSettings } from "@/services/studio";
import { studioBaseKey } from "@/services/studio";

import { CandidateActions, RequestStudioForm, type StudioEstimates } from "./studio-forms";

/** A conta de cada combinação qualidade × nº de opções, pronta para o botão. */
function buildEstimates(): StudioEstimates {
  const table = (quality: "economica" | "alta") =>
    [1, 2, 3, 4].map((options) => formatCentsBRL(usdCentsToBrlCents(estimateRequestUsdCents({ options, quality }).totalUsdCents)));
  return { economica: table("economica"), alta: table("alta") };
}

export function StudioBlock({
  productId,
  pieceType,
  colorOptions,
  hasRealPhoto,
  settings,
  basePhotos,
  requests,
  storage,
}: {
  productId: string;
  pieceType: string | null;
  colorOptions: string[];
  hasRealPhoto: boolean;
  settings: StudioSettings;
  basePhotos: StudioBasePhoto[];
  requests: StudioRequestView[];
  storage: FileStorage;
}) {
  const category = garmentCategoryFor(parsePieceType(pieceType ?? ""));
  const chosen = new Set(basePhotos.filter((photo) => photo.status === "chosen").map((photo) => studioBaseKey(photo)));
  const hasAnyBase = chosen.size > 0;
  const models = HOUSE_MODELS.map((model) => ({
    key: model.key,
    label: model.label,
    available: SCENE_PRESETS.some((scene) => BODY_SIZES.some((size) => chosen.has(studioBaseKey({ modelKey: model.key, sceneKey: scene.key, sizeKey: size.key })))),
  }));
  const sizes = BODY_SIZES.map((size) => ({
    key: size.key,
    label: size.label,
    available: HOUSE_MODELS.some((model) => SCENE_PRESETS.some((scene) => chosen.has(studioBaseKey({ modelKey: model.key, sceneKey: scene.key, sizeKey: size.key })))),
  }));

  let blocker: { title: string; hint: string; href?: string; link?: string } | null = null;
  if (!settings.enabled) {
    blocker = { title: "A foto no corpo está desligada.", hint: "Ligue em Vendedora & WhatsApp quando as fotos-base estiverem escolhidas.", href: "/admin/whatsapp", link: "Ir para Vendedora & WhatsApp" };
  } else if (!isImageStudioConfigured()) {
    blocker = { title: "Falta a chave da FASHN na hospedagem.", hint: "Cadastre FASHN_API_KEY na Vercel (passo a passo em docs/setup-externo.md, seção 10). Até lá nada é gerado." };
  } else if (!category) {
    blocker = { title: "Esta peça não tem ensaio.", hint: "Marque o tipo (vestido, blusa, saia…) em Dados básicos — acessórios não vestem.", href: "#dados-basicos", link: "Ir para Dados básicos" };
  } else if (!hasRealPhoto) {
    blocker = { title: "Suba uma foto real da peça primeiro.", hint: "É a foto esticada que a modelo veste — a estampa é transferida, não redesenhada.", href: "#imagens", link: "Ir para Imagens" };
  } else if (!hasAnyBase) {
    blocker = { title: "Nenhuma foto-base escolhida ainda.", hint: "Gere e escolha a foto-base de cada modelo em cada cena (uma vez).", href: "/admin/produtos/modelos-da-casa", link: "Ir para Modelos da casa" };
  }

  return (
    <Card
      id="foto-no-corpo"
      title="Foto no corpo"
      description="A foto real da peça vira foto dela no corpo de uma modelo da casa, numa cena de Belém. Você escolhe uma das opções; ela entra depois das fotos reais, pareada à cor, e vai para o post do Instagram e para os cartões da Lia (na vitrine só com o interruptor)."
    >
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
          <RequestStudioForm
            productId={productId}
            colorOptions={colorOptions}
            scenes={SCENE_PRESETS.map((scene) => ({ key: scene.key, label: scene.label }))}
            models={models}
            sizes={sizes}
            defaults={{ sceneKey: settings.defaultScene, modelKey: settings.defaultModel, sizeKey: "M", quality: settings.quality }}
            estimates={buildEstimates()}
          />
        )}

        {requests.length > 0 ? (
          <div className="flex flex-col gap-5">
            {requests.map((request) => {
              const status = requestLabel(request);
              const scene = SCENE_PRESETS.find((item) => item.key === request.sceneKey)?.label ?? request.sceneKey;
              const model = HOUSE_MODELS.find((item) => item.key === request.modelKey)?.label ?? request.modelKey;
              const visible = request.candidates.filter((candidate) => candidate.status !== "discarded");
              return (
                <section key={request.id} aria-label={`Pedido de ${formatDateTimeSP(request.createdAt)}`} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span>
                      {formatDateTimeSP(request.createdAt)} · {request.color ?? "produto inteiro"} · {scene} · {model} · corpo {request.sizeKey} · {request.quality === "alta" ? "alta" : "econômica"}
                    </span>
                    <span className="text-zinc-400">· gasto {formatCentsBRL(usdCentsToBrlCents(request.usdCentsSpent))}</span>
                    {request.status === "queued" ? (
                      <Link href={`/admin/produtos/${productId}#foto-no-corpo`} className="text-xs underline">
                        atualizar
                      </Link>
                    ) : null}
                  </div>
                  {visible.length === 0 ? (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">{request.status === "queued" ? "Gerando… cada opção leva perto de meio minuto." : "Nenhuma opção ficou."}</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                      {visible.map((candidate) => {
                        const label = candidateLabel(candidate);
                        return (
                          <div key={candidate.id} className="flex flex-col gap-2">
                            {candidate.storagePath ? (
                              <a href={storage.publicUrl(candidate.storagePath)} target="_blank" rel="noreferrer" title="Abrir em tamanho grande">
                                <img
                                  src={storage.publicUrl(candidate.storagePath)}
                                  alt={`Opção ${candidate.optionNo}`}
                                  className="aspect-[3/4] w-full rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                                />
                              </a>
                            ) : (
                              <div className="flex aspect-[3/4] w-full items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-700">sem imagem</div>
                            )}
                            <Badge tone={label.tone}>{label.label}</Badge>
                            {candidate.status === "candidate" || candidate.status === "rejected" ? (
                              <CandidateActions candidateId={candidate.id} productId={productId} canChoose={candidate.status === "candidate" && Boolean(candidate.storagePath)} />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
