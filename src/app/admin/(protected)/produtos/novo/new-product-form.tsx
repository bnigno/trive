"use client";

import { CARE_SYMBOL_KEYS, formatCareNotes } from "@/core/catalog/care";
import { CareFields } from "../care-fields";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { shrinkImage, uploadBlocker } from "@/components/admin/shrink-image";
import { Card } from "@/components/ui/card";
import {
  Button,
  Field,
  FormError,
  Input,
  Select,
  TextArea,
} from "@/components/ui/form";
import {
  COLOR_AXIS,
  MAX_AXIS_VALUES,
  MAX_GRID_ROWS,
  buildVariantGrid,
} from "@/core/catalog/variant-grid";
import { MEASUREMENT_KEYS, type MeasurementKey } from "@/core/catalog/measurements";
import { parseMeasurementCm } from "./measurements-editor";
import { uploadImagesAction } from "../[id]/actions";
import { createProductAction } from "./actions";
import { ChipsField } from "./chips-field";
import { DraftFromPhotos, type DraftResult } from "./draft-from-photos";
import { MeasurementsEditor, type MeasurementsDraft } from "./measurements-editor";
import { PhotoPicker, type PhotoItem } from "./photo-picker";
import {
  EMPTY_CELL,
  VariantGridEditor,
  type GridCell,
} from "./variant-grid-editor";

export type CategoryOption = { id: string; name: string };

/**
 * "88,5" → 88.5. Campo vazio ou texto sem número não entra (o servidor
 * recusaria a peça inteira por causa de uma medida mal digitada).
 */
function parseMeasurementsInput(
  values: Partial<Record<MeasurementKey, string>> | undefined,
): Record<string, number> | undefined {
  if (!values) return undefined;
  const out: Record<string, number> = {};
  for (const key of MEASUREMENT_KEYS) {
    // Medida a medida: "70,3" numa coluna não pode zerar as outras cinco.
    const value = parseMeasurementCm(values[key]);
    if (value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Centavos → "129,90" para o campo de texto do formulário. */
function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

const SIZE_SUGGESTIONS = [
  "PP",
  "P",
  "M",
  "G",
  "GG",
  "36",
  "37",
  "38",
  "39",
  "40",
  "41",
  "42",
  "43",
  "44",
];

/**
 * Uma foto por requisição, e a server action aceita 8 MB por requisição
 * (next.config.ts). 7 MB deixa folga para o resto do formulário.
 */

/**
 * As duas fases do cadastro. Depois de "creating" dar certo o produto EXISTE:
 * daí para frente nada mais pode dar a entender que ele se perdeu.
 */
type Phase =
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "photos-failed"; sent: number; total: number }
  | { kind: "leaving" };

export function NewProductForm({
  categoryOptions,
  draftEnabled,
}: {
  categoryOptions: CategoryOption[];
  /** "Começar pela foto" ligado nas Configurações. */
  draftEnabled: boolean;
}) {
  const router = useRouter();

  const [name, setName] = useState("");
  /**
   * Rascunho da foto: os campos livres continuam não controlados (é a dona
   * que escreve), então a chegada do rascunho REMONTA os cards com os novos
   * valores padrão — por isso o contador de versão.
   */
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  /** Fita métrica por tamanho, como texto (vem da foto da tabela ou da mão). */
  const [measurements, setMeasurements] = useState<MeasurementsDraft>({});
  const [measurementsFromPhoto, setMeasurementsFromPhoto] = useState(false);
  /**
   * Remontar os cards para receber o rascunho zera os campos não controlados.
   * O que a dona já tinha escrito (e o que o rascunho não traz) é lido do
   * formulário ANTES e volta como valor padrão.
   */
  const [kept, setKept] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const [colors, setColors] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [cells, setCells] = useState<Record<string, GridCell>>({});
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [photoNotice, setPhotoNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [productId, setProductId] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const photoCounter = useRef(0);

  const grid = useMemo(
    () => buildVariantGrid({ name, colors, sizes }),
    [name, colors, sizes],
  );

  const selectedCount = grid.combinations.filter(
    (combination) => (cells[combination.key]?.quantity ?? "").trim() !== "",
  ).length;
  const overLimit = grid.combinations.length > MAX_GRID_ROWS;

  /**
   * Só as cores que vão virar variação entram no seletor da foto: o catálogo
   * recusa foto de uma cor que o produto não tem.
   */
  const photoColors = useMemo(() => {
    if (!grid.axes.includes(COLOR_AXIS)) return [];
    const chosen = new Set<string>();
    for (const combination of grid.combinations) {
      if ((cells[combination.key]?.quantity ?? "").trim() === "") continue;
      const color = combination.attributes[COLOR_AXIS];
      if (color) chosen.add(color);
    }
    return [...chosen];
  }, [grid, cells]);

  const locked = productId !== undefined;

  const handleCellChange = useCallback(
    (key: string, patch: Partial<GridCell>) => {
      setCells((current) => ({
        ...current,
        [key]: { ...(current[key] ?? EMPTY_CELL), ...patch },
      }));
    },
    [],
  );

  const handleFillAll = useCallback(
    (patch: { quantity?: string; cost?: string }) => {
      setCells((current) => {
        const next: Record<string, GridCell> = { ...current };
        for (const combination of grid.combinations) {
          next[combination.key] = {
            ...(current[combination.key] ?? EMPTY_CELL),
            ...patch,
          };
        }
        return next;
      });
    },
    [grid],
  );

  // Foto escolhida à mão é reduzida no navegador como as do rascunho: na
  // Vercel cada requisição aceita 4,5 MB e a foto crua da câmera passa disso.
  const handleAddPhotos = useCallback(async (files: File[]) => {
    const rejected: string[] = [];
    const accepted: PhotoItem[] = [];
    for (const original of files) {
      if (!original.type.startsWith("image/")) {
        rejected.push(`"${original.name}"`);
        continue;
      }
      const { file, shrunk } = await shrinkImage(original);
      if (uploadBlocker(file.size, shrunk)) {
        rejected.push(`"${original.name}"`);
        continue;
      }
      photoCounter.current += 1;
      accepted.push({
        id: `foto-${photoCounter.current}`,
        file,
        color: "",
        status: "pending",
      });
    }
    if (accepted.length > 0) {
      setPhotos((current) => [...current, ...accepted]);
    }
    setPhotoNotice(
      rejected.length === 0
        ? undefined
        : `Deixei de fora ${rejected.join(", ")} — precisa ser uma imagem que o navegador consiga abrir (HEIC fora do iPhone não abre: converta para JPEG).`,
    );
  }, []);

  const handleRemovePhoto = useCallback((id: string) => {
    setPhotos((current) => current.filter((photo) => photo.id !== id));
  }, []);

  const handlePhotoColor = useCallback((id: string, color: string) => {
    setPhotos((current) =>
      current.map((photo) => (photo.id === id ? { ...photo, color } : photo)),
    );
  }, []);

  const goToProduct = useCallback(
    (id: string) => {
      setPhase({ kind: "leaving" });
      router.push(`/admin/produtos/${id}`);
    },
    [router],
  );

  /** Fase 2: uma foto por requisição, para não estourar o limite da action. */
  const sendPhotos = useCallback(
    async (id: string, queue: PhotoItem[], allowedColors: string[]) => {
      const pending = queue.filter((photo) => photo.status !== "sent");
      if (pending.length === 0) {
        goToProduct(id);
        return;
      }

      const total = queue.length;
      let done = total - pending.length;
      let failures = 0;

      for (const photo of pending) {
        setPhase({ kind: "uploading", done, total });

        const body = new FormData();
        body.set("productId", id);
        body.set("files", photo.file);
        // Cor que sumiu da grade depois da escolha vira "todas as cores".
        body.set(
          "color",
          allowedColors.includes(photo.color) ? photo.color : "",
        );

        let outcome: { error?: string };
        try {
          outcome = await uploadImagesAction({}, body);
        } catch {
          outcome = {
            error: "não consegui falar com o servidor.",
          };
        }

        done += 1;
        if (outcome.error) {
          failures += 1;
          setPhotos((current) =>
            current.map((item) =>
              item.id === photo.id
                ? { ...item, status: "failed", error: outcome.error }
                : item,
            ),
          );
        } else {
          setPhotos((current) =>
            current.map((item) =>
              item.id === photo.id
                ? { ...item, status: "sent", error: undefined }
                : item,
            ),
          );
        }
      }

      if (failures === 0) {
        goToProduct(id);
        return;
      }
      setPhase({ kind: "photos-failed", sent: total - failures, total });
    },
    [goToProduct],
  );

  const handleMeasurement = useCallback((size: string, key: MeasurementKey, value: string) => {
    setMeasurements((current) => ({
      ...current,
      [size]: { ...(current[size] ?? {}), [key]: value },
    }));
  }, []);

  const handleDraft = useCallback((result: DraftResult) => {
    const form = formRef.current;
    const fromPhoto: MeasurementsDraft = {};
    for (const [size, values] of Object.entries(result.draft.measurementsBySize)) {
      fromPhoto[size] = Object.fromEntries(
        MEASUREMENT_KEYS.filter((key) => values[key] !== undefined).map((key) => [
          key,
          String(values[key]).replace(".", ","),
        ]),
      );
    }
      // Mescla: a tabela da foto vence tamanho por tamanho, o que a dona
      // mediu à mão nos outros tamanhos continua.
      setMeasurements((current) => ({ ...current, ...fromPhoto }));
    if (Object.keys(fromPhoto).length > 0) setMeasurementsFromPhoto(true);
    if (form) {
      const data = new FormData(form);
      const text = (name: string) => String(data.get(name) ?? "").trim();
      setKept({
        description: text("description"),
        composition: text("composition"),
        fitNotes: text("fitNotes"),
        brand: text("brand"),
        categoryId: text("categoryId"),
        careText: text("careText"),
        price: text("price"),
        weightGrams: text("weightGrams"),
        careSymbols: CARE_SYMBOL_KEYS.filter((key) => data.get(`care:${key}`) === "on").join(","),
      });
    }
    setDraft(result);
    setDraftVersion((current) => current + 1);
    setName(result.draft.name);
    setColors(result.draft.colors);
    setSizes(result.draft.sizes);

    // O custo digitado no card vale para a grade INTEIRA — e a grade só existe
    // com as cores e os tamanhos que acabaram de chegar, então ela é montada
    // aqui (a `grid` do render anterior ainda está vazia).
    const cost = result.costInput.trim();
    if (cost !== "") {
      const nextGrid = buildVariantGrid({
        name: result.draft.name,
        colors: result.draft.colors,
        sizes: result.draft.sizes,
      });
      setCells((current) => {
        const next: Record<string, GridCell> = { ...current };
        for (const combination of nextGrid.combinations) {
          next[combination.key] = { ...(current[combination.key] ?? EMPTY_CELL), cost };
        }
        return next;
      });
    }

    // Só a PRIMEIRA foto vira foto da peça: a etiqueta e a tabela de medidas
    // são material de leitura. Um segundo rascunho troca o lote, não soma.
    const [firstPhoto] = result.photos;
    setPhotos((current) => {
      const kept = current.filter((photo) => photo.source !== "draft");
      if (!firstPhoto) return kept;
      photoCounter.current += 1;
      return [
        ...kept,
        {
          id: `foto-${photoCounter.current}`,
          file: firstPhoto,
          color: "",
          status: "pending" as const,
          source: "draft" as const,
        },
      ];
    });
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // O produto já existe: um segundo envio criaria um cadastro duplicado.
    if (locked || phase.kind === "creating") return;

    if (overLimit) {
      setError(
        `A grade ficou com ${grid.combinations.length} combinações e o limite desta tela é ${MAX_GRID_ROWS}. Tire algumas cores ou tamanhos.`,
      );
      return;
    }
    if (selectedCount === 0) {
      setError(
        "Preencha a quantidade de pelo menos uma combinação — é a quantidade que diz quais existem.",
      );
      return;
    }

    // As medidas digitadas viram números uma vez só; a combinação pega a do
    // seu tamanho pela mesma regra do core.
    const measurementsBySizeParsed = Object.fromEntries(
      Object.entries(measurements)
        .map(([size, values]) => [size, parseMeasurementsInput(values)] as const)
        .filter((entry): entry is readonly [string, Record<string, number>] => entry[1] !== undefined),
    );

    const formData = new FormData(event.currentTarget);
    const payload = {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      composition: String(formData.get("composition") ?? ""),
      careNotes:
        formatCareNotes(
          CARE_SYMBOL_KEYS.filter((key) => formData.get(`care:${key}`) === "on"),
          String(formData.get("careText") ?? "").split("\n"),
        ) ?? "",
      fitNotes: String(formData.get("fitNotes") ?? ""),
      brand: String(formData.get("brand") ?? ""),
      categoryId: String(formData.get("categoryId") ?? ""),
      price: String(formData.get("price") ?? ""),
      weightGrams: String(formData.get("weightGrams") ?? ""),
      colors,
      sizes,
      measurementsBySize: measurementsBySizeParsed,
      rows: grid.combinations.map((combination) => {
        const cell = cells[combination.key];
        return {
          attributes: combination.attributes,
          // O SKU que o dono está vendo é o que vai — em branco, o servidor
          // gera o dele.
          sku: cell?.sku ?? combination.sku,
          quantity: cell?.quantity ?? "",
          cost: cell?.cost ?? "",
        };
      }),
    };

    setError(undefined);
    setPhase({ kind: "creating" });

    const body = new FormData();
    body.set("payload", JSON.stringify(payload));

    let result: { error?: string; productId?: string };
    try {
      result = await createProductAction({}, body);
    } catch {
      result = { error: "Não consegui falar com o servidor. Tente de novo." };
    }

    if (!result.productId) {
      setPhase({ kind: "form" });
      setError(result.error ?? "Algo deu errado, tente novamente.");
      return;
    }

    setProductId(result.productId);
    await sendPhotos(result.productId, photos, photoColors);
  }

  const keptCareSymbols = (kept.careSymbols ?? "")
    .split(",")
    .filter((key): key is (typeof CARE_SYMBOL_KEYS)[number] =>
      (CARE_SYMBOL_KEYS as readonly string[]).includes(key),
    );

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-6">
      {draftEnabled ? <DraftFromPhotos disabled={locked} onDraft={handleDraft} /> : null}
      {/* fieldset desabilitado congela a tela inteira depois que o produto
          nasce: mexer nos campos aqui não mudaria mais nada no banco. */}
      <fieldset
        disabled={locked}
        className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
      >
        <Card title="Dados do produto" key={`dados-${draftVersion}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome" className="sm:col-span-2">
              <Input
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                placeholder="Ex.: Vestido Áurea"
              />
            </Field>
            <Field label="Descrição" className="sm:col-span-2">
              <TextArea
                name="description"
                rows={4}
                defaultValue={draft?.draft.description || kept.description || undefined}
                placeholder="Tecido, caimento, ocasião, como veste no calor de Belém (200 caracteres deixam a peça pronta)"
              />
            </Field>
            <Field label="Composição" className="sm:col-span-2" hint="Ex.: 100% linho · forro 100% viscose">
              <Input
                name="composition"
                placeholder="Tecido e forro (opcional)"
                defaultValue={draft?.draft.composition || kept.composition || undefined}
              />
            </Field>
            <CareFields
              symbols={
                draft?.draft.careSymbols.length ? draft.draft.careSymbols : keptCareSymbols
              }
              freeText={
                draft?.draft.careFreeText.length
                  ? draft.draft.careFreeText
                  : kept.careText
                    ? kept.careText.split("\n")
                    : []
              }
            />
            <Field label="Como veste" className="sm:col-span-2" hint="Caimento, modelagem, altura da modelo.">
              <TextArea
                name="fitNotes"
                rows={2}
                placeholder="Opcional"
                defaultValue={draft?.draft.fitNotes || kept.fitNotes || undefined}
              />
            </Field>
            <Field label="Marca">
              <Input name="brand" placeholder="Ex.: TRIVÉ (opcional)" defaultValue={kept.brand || undefined} />
            </Field>
            <Field label="Categoria">
              <Select name="categoryId" defaultValue={draft?.draft.categoryId ?? kept.categoryId ?? ""}>
                <option value="">Sem categoria</option>
                {categoryOptions.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title="Variações" key={`variacoes-${draftVersion}`}>
          <div className="flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <ChipsField
                label="Cores"
                placeholder="Verde, Preto…"
                hint="Digite a cor e aperte Enter. Sem cores? Deixe vazio."
                values={colors}
                onChange={setColors}
                maxValues={MAX_AXIS_VALUES}
              />
              <ChipsField
                label="Tamanhos"
                placeholder="P, M, 38…"
                hint="Digite o tamanho e aperte Enter, ou use os atalhos."
                values={sizes}
                onChange={setSizes}
                suggestions={SIZE_SUGGESTIONS}
                suggestionsLabel="Atalhos:"
                maxValues={MAX_AXIS_VALUES}
              />
            </div>

            <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                Medidas por tamanho (fita métrica)
              </h3>
              <MeasurementsEditor
                sizes={sizes}
                values={measurements}
                fromPhoto={measurementsFromPhoto}
                onChange={handleMeasurement}
              />
            </div>

            <VariantGridEditor
              grid={grid}
              cells={cells}
              onCellChange={handleCellChange}
              onFillAll={handleFillAll}
              selectedCount={selectedCount}
              defaultPrice={
                draft?.suggestedPriceCents != null
                  ? centsToInput(draft.suggestedPriceCents)
                  : (kept.price ?? "")
              }
              defaultWeightGrams={
                draft?.draft.weightGrams != null
                  ? String(draft.draft.weightGrams)
                  : (kept.weightGrams ?? "")
              }
            />
          </div>
        </Card>

        <Card title="Fotos">
          <div className="flex flex-col gap-3">
            <PhotoPicker
              photos={photos}
              colors={photoColors}
              locked={locked}
              hint={
                photoColors.length > 0
                  ? "As fotos vão junto assim que o produto for salvo. Marque de qual cor é cada uma — ou deixe em “Todas as cores”."
                  : "As fotos vão junto assim que o produto for salvo. Você também pode acrescentar mais depois, na tela do produto."
              }
              onAdd={handleAddPhotos}
              onRemove={handleRemovePhoto}
              onColorChange={handlePhotoColor}
            />
            <FormError message={photoNotice} />
          </div>
        </Card>
      </fieldset>

      <FormError message={error} />

      {locked ? (
        <PhotoPhasePanel
          phase={phase}
          photos={photos}
          onRetry={() =>
            productId ? sendPhotos(productId, photos, photoColors) : undefined
          }
          onSkip={() => (productId ? goToProduct(productId) : undefined)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={phase.kind === "creating"}>
            {phase.kind === "creating" ? "Criando…" : "Criar produto"}
          </Button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {photos.length > 0
              ? photos.length === 1
                ? "Primeiro salvo o produto; depois envio a foto."
                : `Primeiro salvo o produto; depois envio as ${photos.length} fotos, uma a uma.`
              : "Você pode acrescentar fotos agora ou depois, na tela do produto."}
          </p>
        </div>
      )}
    </form>
  );
}

function PhotoPhasePanel({
  phase,
  photos,
  onRetry,
  onSkip,
}: {
  phase: Phase;
  photos: PhotoItem[];
  onRetry: () => void;
  onSkip: () => void;
}) {
  if (phase.kind === "uploading") {
    const percent = phase.total === 0 ? 100 : (phase.done / phase.total) * 100;
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Produto criado. Enviando foto {Math.min(phase.done + 1, phase.total)}{" "}
            de {phase.total}…
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full bg-indigo-600 transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </Card>
    );
  }

  if (phase.kind === "photos-failed") {
    const failed = photos.filter((photo) => photo.status !== "sent");
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            O produto está salvo — nada se perdeu. {phase.sent} de {phase.total}{" "}
            fotos subiram.
          </p>
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">
              {failed.length === 1
                ? "Esta foto não subiu:"
                : "Estas fotos não subiram:"}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {failed.map((photo) => (
                <li key={photo.id}>
                  {photo.file.name}
                  {photo.error ? ` — ${photo.error}` : null}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={onRetry}>Tentar de novo</Button>
            <Button variant="outline" onClick={onSkip}>
              Abrir o produto assim mesmo
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {phase.kind === "leaving"
          ? "Produto criado. Abrindo a tela dele…"
          : "Produto criado. Um instante…"}
      </p>
    </Card>
  );
}
