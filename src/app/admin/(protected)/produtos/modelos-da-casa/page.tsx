import type { Metadata } from "next";
import Link from "next/link";

import { isImageStudioConfigured } from "@/adapters/image-studio";
import { getFileStorage } from "@/adapters/storage";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { creditsFor, creditsToUsdCents, usdCentsToBrlCents } from "@/core/studio/cost";
import { BODY_SIZES, HOUSE_MODELS, SCENE_PRESETS } from "@/core/studio/presets";
import { getDb } from "@/db/client";
import { formatCentsBRL } from "@/lib/money";
import { requireOwner } from "@/services/auth";
import { listPendingStudioBasePhotoJobs, listStudioBasePhotos, loadStudioSettings, studioBaseKey } from "@/services/studio";

import { BasePhotoActions, RequestBasePhotosForm } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Modelos da casa" };

/** Marco 1: um corpo (M) por cena; os outros corpos entram com "veja no seu tamanho". */
const SIZE_KEY = "M";

// Modelos da casa: as fotos-base que toda peça veste. Três modelos fixas,
// quatro cenas de Belém; a dona gera duas candidatas por combinação e
// escolhe uma (uma vez). Custo e vendor são dado do dono: página inteira dele.
export default async function ModelasDaCasaPage() {
  await requireOwner("produtos");
  const db = getDb();
  const [settings, photos, pending] = await Promise.all([loadStudioSettings(db), listStudioBasePhotos(db), listPendingStudioBasePhotoJobs(db)]);
  const storage = getFileStorage();
  const costLabel = formatCentsBRL(usdCentsToBrlCents(creditsToUsdCents(creditsFor("model_photo", "alta", 2))));
  const size = BODY_SIZES.find((item) => item.key === SIZE_KEY)!;
  const chosenCount = photos.filter((photo) => photo.status === "chosen" && photo.sizeKey === SIZE_KEY).length;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Modelos da casa"
        subtitle={`${chosenCount} de ${HOUSE_MODELS.length * SCENE_PRESETS.length} fotos-base escolhidas · corpo ${size.label}`}
        actions={
          <Link href="/admin/produtos" className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400">
            Voltar para produtos
          </Link>
        }
      />

      <Card
        title="Como funciona"
        description="Cada peça veste uma destas fotos: a mesma modelo, na mesma cena, em toda a edição — é isso que dá consistência ao feed. Gere duas candidatas por combinação, olhe com calma (pele, luz, mãos, fundo) e escolha uma. Nenhuma modelo é parecida com pessoa real; nunca se usa foto de cliente."
      >
        <div className="flex flex-col gap-2 text-sm text-zinc-600 dark:text-zinc-300">
          {!settings.enabled ? (
            <p>
              A foto no corpo está <strong>desligada</strong> — as fotos-base podem ser geradas mesmo assim; ligue em{" "}
              <Link href="/admin/whatsapp" className="underline">
                Vendedora &amp; WhatsApp
              </Link>{" "}
              quando estiverem escolhidas.
            </p>
          ) : null}
          {!isImageStudioConfigured() ? <p className="text-amber-700 dark:text-amber-300">Falta a chave da FASHN na hospedagem (FASHN_API_KEY): os pedidos vão para a fila e falham até ela existir.</p> : null}
          <p>Cada pedido gera 2 candidatas em qualidade alta (2K) — ≈ {costLabel}. As candidatas ficam guardadas; trocar a escolhida não custa nada.</p>
          <ul className="mt-1 grid gap-1 sm:grid-cols-3">
            {HOUSE_MODELS.map((model) => (
              <li key={model.key}>
                <span className="font-medium text-zinc-900 dark:text-zinc-100">{model.label}</span> — {model.description}
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {SCENE_PRESETS.map((scene) => (
        <Card key={scene.key} title={scene.label} description={scene.description}>
          <div className="grid gap-6 md:grid-cols-3">
            {HOUSE_MODELS.map((model) => {
              const keys = { modelKey: model.key, sceneKey: scene.key, sizeKey: SIZE_KEY };
              const key = studioBaseKey(keys);
              const cell = photos.filter((photo) => studioBaseKey(photo) === key);
              const chosen = cell.find((photo) => photo.status === "chosen") ?? null;
              const candidates = cell.filter((photo) => photo.status === "candidate");
              return (
                <section key={model.key} aria-label={`${model.label} — ${scene.label}`} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{model.label}</h3>
                    {chosen ? <Badge tone="success">Escolhida</Badge> : pending.has(key) ? <Badge tone="info">Gerando…</Badge> : <Badge tone="warning">Sem foto-base</Badge>}
                  </div>
                  {cell.length === 0 ? (
                    <div className="flex aspect-[3/4] items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-700">nenhuma candidata</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {[...(chosen ? [chosen] : []), ...candidates].map((photo) => (
                        <div key={photo.id} className="flex flex-col gap-2">
                          <a href={storage.publicUrl(photo.storagePath)} target="_blank" rel="noreferrer" title="Abrir em tamanho grande">
                            <img
                              src={storage.publicUrl(photo.storagePath)}
                              alt={`${model.label} — ${scene.label}`}
                              className={`aspect-[3/4] w-full rounded-md border object-cover ${photo.status === "chosen" ? "border-emerald-500 ring-2 ring-emerald-500/40" : "border-zinc-200 dark:border-zinc-700"}`}
                            />
                          </a>
                          <BasePhotoActions id={photo.id} chosen={photo.status === "chosen"} />
                        </div>
                      ))}
                    </div>
                  )}
                  <RequestBasePhotosForm modelKey={model.key} sceneKey={scene.key} sizeKey={SIZE_KEY} costLabel={costLabel} pending={pending.has(key)} />
                </section>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
}
