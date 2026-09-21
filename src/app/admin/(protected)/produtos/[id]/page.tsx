import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { categories } from "@/db/schema";
import { getFileStorage } from "@/adapters/storage";
import { isTranscriptionConfigured } from "@/adapters/transcription";
import { isOwner, requireUser } from "@/services/auth";
import { getProductDetail, thumbPathFor } from "@/services/catalog";
import { listProductReadiness } from "@/services/catalog-readiness";
import { getAtelierIntakeForProduct } from "@/services/atelier";
import { listStudioBasePhotos, listStudioRequestsForProduct, loadStudioSettings } from "@/services/studio";
import { countPublicLooksForProduct } from "@/services/customer-looks";
import { getFitSignalsForProduct } from "@/services/delivery-feedback";
import { FIT_SIGNAL_LABELS } from "@/core/catalog/fit-signal";
import { careLabels } from "@/core/atelier/proposal";
import { errorDetailLabel, interpretationFailedLabel } from "@/core/atelier/reply";
import { formatUsdCents } from "@/core/ai/model-cost";
import { formatDateTimeSP } from "@/emails/templates";
import { formatCentsBRL } from "@/lib/money";
import { axisValues } from "@/core/catalog/attributes";
import { buildSizeChart, compareSizeLabels, findSizeAxis } from "@/core/catalog/measurements";
import { suggestSkuForVariant } from "@/core/catalog/sku";
import { findColorAxis } from "@/core/catalog/product-images";
import { listSuppliers } from "@/services/suppliers";
import { LowStockBadge } from "@/components/admin/low-stock-alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CuratorNoteForm } from "./curator-note-form";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/form";
import { Money } from "@/components/ui/money";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, Td, Tr } from "@/components/ui/table";
import { OwnerOnly } from "../../owner-only";
import { removeImageAction, setProductStatusAction } from "./actions";
import { EditProductForm } from "./edit-product-form";
import { ImageColorForm } from "./image-color-form";
import { ImageUploadForm } from "./image-upload-form";
import { StudioBlock } from "./studio-block";
import { AddVariantForm, EditVariantForm } from "./variant-forms";
import { MeasurementsForm } from "./measurements-form";
import { readinessIssueHref } from "../readiness-badge";

export const dynamic = "force-dynamic";
/** A nota da curadora roda upload + transcrição (até 20 s) dentro da action desta página. */
export const maxDuration = 60;

export const metadata: Metadata = {
  title: "Produto",
};

type ProductStatus = "draft" | "active" | "archived";

const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  archived: "Arquivado",
};

const STATUS_TONES: Record<ProductStatus, "warning" | "success" | "neutral"> = {
  draft: "warning",
  active: "success",
  archived: "neutral",
};

const STATUS_HINTS: Record<ProductStatus, string> = {
  draft: "Rascunho: o produto ainda não aparece na loja.",
  active: "Ativo: o produto aparece na loja e pode ser vendido.",
  archived:
    "Arquivado: o produto saiu do catálogo, mas pedidos antigos continuam mostrando ele normalmente.",
};

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatAttributes(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

export default async function ProdutoDetalhePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ foco?: string }>;
}) {
  await requireUser();
  const owner = await isOwner();
  const { id } = await params;
  const { foco } = await searchParams;

  const db = getDb();
  let detail: Awaited<ReturnType<typeof getProductDetail>>;
  try {
    detail = await getProductDetail(db, id);
  } catch {
    // Id inválido ou produto não encontrado.
    notFound();
  }

  const [categoryRows, readiness, atelierIntake, fitSignals, publicLooks] = await Promise.all([
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .orderBy(asc(categories.name)),
    listProductReadiness(db, { productIds: [detail.id] }).then((map) => map.get(detail.id)),
    getAtelierIntakeForProduct(db, id),
    getFitSignalsForProduct(db, id),
    countPublicLooksForProduct(db, id),
  ]);
  // O ensaio (foto no corpo) é do dono: custo e vendor não viajam para a equipe.
  const studio = owner
    ? await Promise.all([loadStudioSettings(db), listStudioBasePhotos(db), listStudioRequestsForProduct(db, id)]).then(
        ([settings, basePhotos, requests]) => ({ settings, basePhotos, requests }),
      )
    : null;
  // Vindo do selo "sem peso": abre e foca a primeira variação ativa sem peso.
  const focusWeightVariantId =
    foco === "weightGrams"
      ? (detail.variants.find(
          (variant) =>
            variant.isActive && (variant.weightGrams === null || variant.weightGrams <= 0),
        )?.id ?? detail.variants[0]?.id ?? null)
      : null;

  // Fornecedor é dado do dono: a equipe nem consulta a lista.
  const supplierOptions = owner
    ? (await listSuppliers(db)).map((supplier) => ({
        id: supplier.id,
        name: supplier.name,
      }))
    : [];

  const storage = getFileStorage();
  const status = (
    detail.status === "active" || detail.status === "archived"
      ? detail.status
      : "draft"
  ) as ProductStatus;
  const axes = Array.isArray(detail.attributesSchema)
    ? detail.attributesSchema.filter(
        (axis): axis is string => typeof axis === "string",
      )
    : [];
  // Produto sem eixo de cor não ganha etiqueta de cor nas fotos.
  const colorAxis = findColorAxis(axes);
  const colorOptions = colorAxis
    ? axisValues(
        colorAxis,
        detail.variants.map((variant) => variant.attributes),
      )
    : [];
  const sizeAxis = findSizeAxis(axes);
  const sizeOptions = sizeAxis
    ? axisValues(
        sizeAxis,
        detail.variants.filter((variant) => variant.isActive).map((variant) => variant.attributes),
      ).sort(compareSizeLabels)
    : [];
  const sizeChart = buildSizeChart(detail.variants, axes);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <PageHeader
        title={detail.name}
        subtitle={`Criado em ${dateTimeFormatter.format(detail.createdAt)}`}
        actions={
          <div className="flex items-center gap-4">
            <Link
              href={`/admin/produtos/${id}/etiquetas`}
              className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100"
            >
              Etiquetas
            </Link>
            <Link
              href={`/admin/produtos/${id}/post`}
              className="text-sm font-medium text-zinc-900 underline dark:text-zinc-100"
            >
              Post da peça
            </Link>
            <Link
              href="/admin/produtos"
              className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400"
            >
              Voltar para produtos
            </Link>
          </div>
        }
      />

      {readiness && readiness.level !== "ready" && readiness.level !== "archived" ? (
        <section
          aria-label="O que falta nesta peça"
          className={
            readiness.level === "blocked"
              ? "rounded-lg border border-red-200 bg-red-50 px-5 py-4 dark:border-red-900 dark:bg-red-950/40"
              : "rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900 dark:bg-amber-950/40"
          }
        >
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {readiness.level === "blocked"
              ? "Esta peça ainda não pode ser vendida"
              : "Quase pronta — falta pouco"}
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {readiness.issues.map((issue) => (
              <li key={issue.code}>
                <Link href={readinessIssueHref(detail.id, issue)} className="hover:underline">
                  <Badge tone={issue.severity === "blocked" ? "danger" : "warning"}>
                    {issue.label}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Card id="status" title="Status">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <StatusPill
              label={STATUS_LABELS[status]}
              tone={STATUS_TONES[status]}
            />
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {STATUS_HINTS[status]}
            </p>
          </div>
          {atelierIntake ? (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
              <p className="text-zinc-700 dark:text-zinc-300">
                <Badge tone="info">Chegou pelo WhatsApp</Badge> {formatDateTimeSP(atelierIntake.createdAt)}
                {atelierIntake.note ? ` · recado: “${atelierIntake.note.slice(0, 240)}${atelierIntake.note.length > 240 ? "…" : ""}”` : ""}
              </p>
              {atelierIntake.parsed?.proposal ? (
                <ul className="mt-2 grid gap-1 text-zinc-600 dark:text-zinc-400 sm:grid-cols-2">
                  <li>Cores: {atelierIntake.parsed.proposal.colors.join(", ") || "—"}</li>
                  <li>Tamanhos: {atelierIntake.parsed.proposal.sizes.join(", ") || "—"}</li>
                  <li>
                    Quantidade:{" "}
                    {atelierIntake.parsed.proposal.quantityPerVariant !== null
                      ? `${atelierIntake.parsed.proposal.quantityPerVariant} de cada (${atelierIntake.parsed.proposal.totalQuantity ?? "?"} peças)`
                      : atelierIntake.parsed.proposal.totalQuantity !== null
                        ? `${atelierIntake.parsed.proposal.totalQuantity} peças`
                        : "não disse"}{" "}
                    {atelierIntake.parsed.purchase
                      ? atelierIntake.parsed.purchase.movements > 0
                        ? ` — ${atelierIntake.parsed.purchase.totalQuantity ?? atelierIntake.parsed.purchase.movements} peças lançadas no estoque na chegada`
                        : atelierIntake.parsed.purchase.purchaseError
                          ? " — a compra não foi lançada (veja abaixo)"
                          : atelierIntake.parsed.purchase.skipped === "total_sem_grade"
                            ? " — total sem 'de cada': distribua o estoque pela grade no painel"
                            : atelierIntake.parsed.purchase.skipped === "sem_quantidade"
                              ? " — sem quantidade, o estoque fica para o painel"
                              : " — estoque já lançado antes"
                      : ""}
                  </li>
                  <li>
                    Custo:{" "}
                    {atelierIntake.parsed.proposal.unitCostCents !== null
                      ? `${formatCentsBRL(atelierIntake.parsed.proposal.unitCostCents)} por peça`
                      : atelierIntake.parsed.proposal.totalCostCents !== null
                        ? `${formatCentsBRL(atelierIntake.parsed.proposal.totalCostCents)} no total`
                        : "não disse"}
                  </li>
                  <li>Preço sugerido: {atelierIntake.parsed.suggestedPriceCents !== null ? formatCentsBRL(atelierIntake.parsed.suggestedPriceCents) : "—"}</li>
                  <li>
                    Fornecedor:{" "}
                    {atelierIntake.supplier ? (
                      <Link href={`/admin/fornecedores/${atelierIntake.supplier.id}`} className="underline">
                        {atelierIntake.supplier.name}
                      </Link>
                    ) : (
                      (atelierIntake.parsed.proposal.supplierName ?? "não disse")
                    )}
                  </li>
                  <li>
                    Conta a pagar:{" "}
                    {atelierIntake.payable ? (
                      <Link href="/admin/financeiro" className="underline">
                        {formatCentsBRL(atelierIntake.payable.amountCents)} ({atelierIntake.payable.status === "pending" ? "pendente" : atelierIntake.payable.status})
                      </Link>
                    ) : (
                      "não lançada"
                    )}
                  </li>
                  {careLabels(atelierIntake.parsed.proposal).length > 0 ? (
                    <li className="sm:col-span-2">Cuidados lidos: {careLabels(atelierIntake.parsed.proposal).join(" · ")}</li>
                  ) : null}
                </ul>
              ) : null}
              {atelierIntake.parsed?.proposal?.warnings.length ? (
                <p className="mt-2 text-amber-800 dark:text-amber-300">Avisos: {atelierIntake.parsed.proposal.warnings.join(" · ")}</p>
              ) : null}
              {atelierIntake.parsed?.failed ? (
                <p className="mt-2 text-amber-800 dark:text-amber-300">
                  A inteligência não montou a grade ({interpretationFailedLabel(atelierIntake.parsed.failed)}): a ficha nasceu simples — complete a grade à mão.
                </p>
              ) : null}
              {atelierIntake.errorDetail ? <p className="mt-1 text-zinc-500">{errorDetailLabel(atelierIntake.errorDetail)}</p> : null}
              {atelierIntake.cardPath ? (
                <p className="mt-1 text-xs text-zinc-500">
                  <a href={storage.publicUrl(atelierIntake.cardPath)} target="_blank" rel="noreferrer" className="underline">
                    Ver o cartão enviado ao seu WhatsApp
                  </a>
                </p>
              ) : null}
              {atelierIntake.parsed?.usage ? (
                <p className="mt-1 text-xs text-zinc-500">
                  Inteligência: {atelierIntake.parsed.model} · {formatUsdCents(atelierIntake.parsed.estimatedCostUsdCents)} · {(atelierIntake.parsed.ms / 1000).toFixed(1)} s
                </p>
              ) : null}
            </div>
          ) : null}
          <OwnerOnly>
            <div className="flex flex-wrap gap-2">
              {status !== "active" ? (
                <form action={setProductStatusAction}>
                  <input type="hidden" name="productId" value={detail.id} />
                  <input type="hidden" name="status" value="active" />
                  <Button type="submit" size="sm">
                    Ativar produto
                  </Button>
                </form>
              ) : null}
              {status !== "draft" ? (
                <form action={setProductStatusAction}>
                  <input type="hidden" name="productId" value={detail.id} />
                  <input type="hidden" name="status" value="draft" />
                  <Button type="submit" variant="outline" size="sm">
                    Voltar para rascunho
                  </Button>
                </form>
              ) : null}
              {status !== "archived" ? (
                <form action={setProductStatusAction}>
                  <input type="hidden" name="productId" value={detail.id} />
                  <input type="hidden" name="status" value="archived" />
                  <ConfirmButton
                    size="sm"
                    confirmMessage="Arquivar este produto? Ele sai do catálogo e não pode mais ser vendido, mas pedidos antigos continuam mostrando ele normalmente. Você pode reativá-lo quando quiser."
                  >
                    Arquivar
                  </ConfirmButton>
                </form>
              ) : null}
            </div>
          </OwnerOnly>
        </div>
      </Card>

      {/* Dados básicos incluem o fornecedor: card inteiro só para o dono. */}
      <OwnerOnly>
        <Card id="dados-basicos" title="Dados básicos">
          <EditProductForm
            autoFocusDescription={foco === "description"}
            autoFocusField={foco === "composition" || foco === "fitNotes" || foco === "pieceType" ? foco : undefined}
            product={{
              id: detail.id,
              name: detail.name,
              description: detail.description,
              brand: detail.brand,
              categoryId: detail.categoryId,
              pieceType: detail.pieceType,
              supplierId: detail.supplierId,
              attributesSchema: axes,
              composition: detail.composition,
              careNotes: detail.careNotes,
              fitNotes: detail.fitNotes,
            }}
            categoryOptions={categoryRows}
            supplierOptions={supplierOptions}
          />
        </Card>
      </OwnerOnly>

      <Card id="imagens" title="Imagens">
        <div className="flex flex-col gap-4">
          {detail.images.length === 0 ? (
            <EmptyState
              title="Este produto ainda não tem imagens."
              hint="Envie fotos do produto — a primeira vira a imagem principal na lista."
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
                {detail.images.map((image) => (
                  <div key={image.id} className="flex flex-col gap-2">
                    <a
                      href={storage.publicUrl(image.storagePath)}
                      target="_blank"
                      rel="noreferrer"
                      title="Abrir imagem em tamanho grande"
                    >
                      { }
                      <img
                        src={storage.publicUrl(thumbPathFor(image.storagePath))}
                        alt={image.altText ?? ""}
                        className="aspect-square w-full rounded-md border border-zinc-200 object-cover dark:border-zinc-700"
                      />
                    </a>
                    {image.origin === "ai" ? (
                      <Badge tone="info">IA · no corpo</Badge>
                    ) : null}
                    {colorAxis ? (
                      owner ? (
                        <ImageColorForm
                          imageId={image.id}
                          productId={detail.id}
                          color={image.color}
                          colorOptions={colorOptions}
                        />
                      ) : (
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {image.color ?? "Produto inteiro"}
                        </p>
                      )
                    ) : null}
                    <OwnerOnly>
                      <form action={removeImageAction}>
                        <input type="hidden" name="imageId" value={image.id} />
                        <input
                          type="hidden"
                          name="productId"
                          value={detail.id}
                        />
                        <ConfirmButton
                          size="sm"
                          variant="outline"
                          className="w-full"
                          confirmMessage="Remover esta imagem? Esta ação não pode ser desfeita."
                        >
                          Remover
                        </ConfirmButton>
                      </form>
                    </OwnerOnly>
                  </div>
                ))}
              </div>
              {colorAxis && owner ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  A cor de cada foto decide o que o cliente vê na loja: ao
                  escolher uma cor, ele vê primeiro as fotos daquela cor. Fotos
                  marcadas como “Produto inteiro” aparecem em qualquer escolha.
                  A cor é salva assim que você escolhe.
                </p>
              ) : null}
            </div>
          )}
          <OwnerOnly>
            <ImageUploadForm productId={detail.id} />
          </OwnerOnly>
        </div>
      </Card>

      {studio ? (
        <StudioBlock
          productId={detail.id}
          pieceType={detail.pieceType}
          colorOptions={colorOptions}
          hasRealPhoto={detail.images.some((image) => image.origin === "upload")}
          settings={studio.settings}
          basePhotos={studio.basePhotos}
          requests={studio.requests}
          storage={storage}
        />
      ) : null}

      <OwnerOnly>
        <Card id="nota-da-curadora" title="Nota da curadora">
          <CuratorNoteForm
            productId={detail.id}
            note={detail.curatorNote ?? ""}
            // Remonta o campo só quando o texto salvo mudou de fato (regravação
            // que transcreveu, edição salva) — nunca por mexer só no áudio.
            noteVersion={`${detail.curatorNoteUpdatedAt?.getTime() ?? 0}:${detail.curatorNote ?? ""}`}
            // O caminho já tem um token por gravação: a URL muda quando o
            // áudio muda, e só então (salvar o texto não reinicia o player).
            audioUrl={detail.curatorAudioPath ? storage.publicUrl(detail.curatorAudioPath) : null}
            audioMime={detail.curatorAudioMime}
            audioSeconds={detail.curatorAudioSeconds}
            transcriptionEnabled={isTranscriptionConfigured()}
          />
        </Card>
      </OwnerOnly>

      <Card id="variacoes" title="Variações">
        <div className="flex flex-col gap-5">
          {detail.variants.length === 0 ? (
            <EmptyState
              title="Este produto não tem variações."
              hint="Adicione ao menos uma variação para controlar estoque e preço."
            />
          ) : (
            <Table
              headers={
                // Custo é dinheiro do negócio: a coluna não existe para a equipe.
                owner
                  ? ["SKU", "Atributos", "Custo", "Preço ativo", "Estoque", "Ações"]
                  : ["SKU", "Atributos", "Preço ativo", "Estoque", "Ações"]
              }
            >
              {detail.variants.map((variant) => (
                <Tr key={variant.id}>
                  <Td className="font-mono text-xs">
                    {variant.sku}
                    {!variant.isActive ? (
                      <Badge tone="neutral" className="ml-2">
                        Inativa
                      </Badge>
                    ) : null}
                  </Td>
                  <Td>{formatAttributes(variant.attributes)}</Td>
                  {owner ? (
                    <Td>
                      <Money cents={variant.costCents} />
                    </Td>
                  ) : null}
                  <Td>
                    {variant.activePriceCents !== null ? (
                      <Money cents={variant.activePriceCents} />
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-500">
                        Sem preço
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="mr-2">{variant.available}</span>
                    <LowStockBadge
                      available={variant.available}
                      threshold={variant.lowStockThreshold ?? 0}
                    />
                  </Td>
                  <Td>
                    <div className="flex gap-3 whitespace-nowrap">
                      {owner ? (
                        <Link
                          href={`/admin/precos/calculadora?variant=${variant.id}`}
                          className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          Precificar
                        </Link>
                      ) : null}
                      <Link
                        href={`/admin/estoque/${variant.id}`}
                        className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        Estoque
                      </Link>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Table>
          )}

          <OwnerOnly>
            {detail.variants.length > 0 ? (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Editar variações
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  O código (SKU) identifica a peça no estoque, nos preços e no
                  bot do WhatsApp. Você pode trocar: pedidos e comprovantes
                  antigos continuam com o código da época; etiquetas e
                  planilhas suas ficam desatualizadas; uma cliente com conversa
                  aberta no WhatsApp pode ter de escolher a peça de novo.
                  Letras viram maiúsculas e espaços viram hífen.
                </p>
                {detail.variants.map((variant) => (
                  <details
                    key={variant.id}
                    open={variant.id === focusWeightVariantId}
                    className="rounded-md border border-zinc-200 dark:border-zinc-800"
                  >
                    <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-700 dark:text-zinc-300">
                      <span className="font-mono text-xs">{variant.sku}</span>
                      <span className="ml-2 text-zinc-500 dark:text-zinc-400">
                        {formatAttributes(variant.attributes)}
                      </span>
                    </summary>
                    <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                      <EditVariantForm
                        productId={detail.id}
                        variant={variant}
                        axes={axes}
                        suggestedSku={suggestSkuForVariant(
                          detail.name,
                          axes,
                          variant.attributes,
                        )}
                        autoFocusWeight={variant.id === focusWeightVariantId}
                      />
                    </div>
                  </details>
                ))}
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Adicionar variação
              </h3>
              <AddVariantForm productId={detail.id} axes={axes} />
            </div>
          </OwnerOnly>
        </div>
      </Card>

      <OwnerOnly>
        <Card title="Quem já vestiu">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {publicLooks === 0 ? "Nenhuma foto de cliente na página desta peça ainda." : `${publicLooks} ${publicLooks === 1 ? "foto de cliente" : "fotos de clientes"} na página da peça.`}{" "}
            <Link href="/admin/produtos/quem-vestiu" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Aprovar e retirar
            </Link>
          </p>
        </Card>
        {fitSignals.length > 0 ? (
          <Card title="Caimento pelas clientes">
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
              Respostas ao “Chegou bem?” por tamanho. A partir de 3 respostas, 60% na mesma direção viram o aviso na vitrine.
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {fitSignals.map((row) => (
                <li key={row.size} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.size}</span>
                  <span className="text-zinc-600 dark:text-zinc-400">
                    amei {row.amei} · ficou grande {row.grande} · ficou pequeno {row.pequeno}
                  </span>
                  {row.signal ? <Badge tone="warning">{FIT_SIGNAL_LABELS[row.signal]}</Badge> : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card id="fita-metrica" title="Fita métrica">
          {sizeAxis && sizeOptions.length > 0 ? (
            <MeasurementsForm productId={detail.id} sizes={sizeOptions} chart={sizeChart} />
          ) : (
            <EmptyState
              title="Esta peça não tem o eixo “tamanho”."
              hint='Adicione "tamanho" nos eixos de variação e crie as variações para cadastrar as medidas.'
            />
          )}
        </Card>
      </OwnerOnly>
    </div>
  );
}
