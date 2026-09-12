"use client";

import { useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button, FormError, FormSuccess, TextArea } from "@/components/ui/form";

import { generateProductPostAction } from "./actions";

export type CarouselColor = {
  color: string;
  /** Já tem cartão no cache (o pré-desenho ou um "Gerar" anterior). */
  hasCard: boolean;
};

/** Um arquivo baixado e a URL de objeto que mostra a miniatura dele. */
type Asset = { file: File; url: string };

type Loaded = {
  /** A qual carregamento estes arquivos pertencem (cores + geração). */
  key: string;
  post: Asset | null;
  story: Asset | null;
  carousel: (Asset | null)[];
  /** Todos os downloads terminaram (com ou sem sucesso). */
  complete: boolean;
  /** O que faltou neste carregamento, para a tela dizer (vazio = tudo chegou). */
  missing: string[];
};

const KEY_SEPARATOR = "";
/** Conexão morta no 4G: desiste e diz para tentar de novo, em vez de travar. */
const FETCH_TIMEOUT_MS = 20_000;

function emptyLoaded(key: string, colorCount: number): Loaded {
  return {
    key,
    post: null,
    story: null,
    carousel: Array.from({ length: colorCount }, () => null),
    complete: false,
    missing: [],
  };
}

function isIphone(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad/.test(navigator.userAgent);
}

/**
 * A tela do post: prévia, Compartilhar (a folha do sistema com post e story,
 * no celular), Só o carrossel (uma imagem por cor), Baixar quando o aparelho
 * não compartilha arquivo, e Copiar legenda. As imagens vêm por uma rota da
 * própria origem, uma vez só: o mesmo arquivo em memória serve à miniatura e
 * ao compartilhamento (que precisa do arquivo, não de uma URL).
 */
export function SharePost({
  productId,
  caption,
  hasPost,
  hasStory,
  carousel,
  omittedColors,
}: {
  productId: string;
  caption: string;
  hasPost: boolean;
  hasStory: boolean;
  /** Cores do carrossel, na ordem (vazio = peça sem carrossel). */
  carousel: CarouselColor[];
  /** Cores que passaram do teto do Instagram e ficaram de fora. */
  omittedColors: string[];
}) {
  const [ready, setReady] = useState(hasPost && hasStory);
  const [loaded, setLoaded] = useState<Loaded>(() => ({ ...emptyLoaded("", 0), complete: true }));
  const [busy, setBusy] = useState(false);
  /** Cada "Gerar" bem-sucedido dispara um único recarregamento das imagens. */
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<string | undefined>();
  const [warning, setWarning] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  // Chaves estáveis para os efeitos: o array de props muda de identidade a
  // cada render do servidor, mas o conteúdo não.
  const colorsKey = carousel.map((entry) => entry.color).join(KEY_SEPARATOR);
  // Depois de um "Gerar" todas as cores têm cartão: a chave para de mudar e o
  // refresh do servidor não baixa tudo de novo.
  const hasCardKey = generation > 0 ? "all" : carousel.map((entry) => (entry.hasCard ? "1" : "0")).join("");
  const loadKey = `${colorsKey}|${hasCardKey}|${generation}`;
  /** Os arquivos deste carregamento (os de um carregamento anterior não valem). */
  const files = loaded.key === loadKey ? loaded : emptyLoaded(loadKey, carousel.length);
  /** As imagens são baixadas assim que a tela abre; até lá, não dá para compartilhar. */
  const loadingFiles = ready && !files.complete;
  const expectsCard = (index: number) => hasCardKey === "all" || carousel[index]?.hasCard === true;

  // As imagens já desenhadas entram em memória assim que a tela abre, cada
  // uma no seu tempo (a miniatura aparece conforme chega). As URLs de objeto
  // nascem com o arquivo e morrem com este carregamento.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const urls: string[] = [];
    const colors = colorsKey === "" ? [] : colorsKey.split(KEY_SEPARATOR);
    const fresh = () => emptyLoaded(loadKey, colors.length);
    const patch = (change: (prev: Loaded) => Partial<Loaded>) =>
      setLoaded((prev) => {
        const base = prev.key === loadKey ? prev : fresh();
        return { ...base, ...change(base) };
      });
    const fetchOne = async (format: string): Promise<Asset | null> => {
      try {
        const response = await fetch(`/admin/produtos/${productId}/post/${format}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        // Sessão expirada responde a página de login (200, text/html): sem esta
        // checagem o "JPEG" compartilhado seria o HTML do login.
        if (!response.ok || response.redirected) return null;
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) return null;
        const file = new File([blob], `${format}.jpg`, { type: "image/jpeg" });
        const url = URL.createObjectURL(file);
        urls.push(url);
        return { file, url };
      } catch {
        // Rede que caiu no meio: a imagem fica de fora e a tela diz o que fazer.
        return null;
      }
    };

    const expected = colors.map((_, index) => hasCardKey === "all" || hasCardKey[index] === "1");
    const postTask = fetchOne("post");
    const storyTask = fetchOne("story");
    const colorTasks = colors.map((_, index) =>
      expected[index] ? fetchOne(`carousel-${index}`) : Promise.resolve<Asset | null>(null),
    );
    void postTask.then((asset) => {
      if (alive) patch(() => ({ post: asset }));
    });
    void storyTask.then((asset) => {
      if (alive) patch(() => ({ story: asset }));
    });
    colorTasks.forEach((task, index) => {
      void task.then((asset) => {
        if (!alive) return;
        patch((prev) => {
          const next = [...prev.carousel];
          next[index] = asset;
          return { carousel: next };
        });
      });
    });
    void Promise.all([postTask, storyTask, ...colorTasks]).then(([post, story, ...cards]) => {
      if (!alive) return;
      const missing = [
        ...(post ? [] : ["o post"]),
        ...(story ? [] : ["o story"]),
        ...colors.filter((_, index) => expected[index] && !cards[index]).map((color) => `a cor ${color}`),
      ];
      patch(() => ({ complete: true, missing }));
    });
    return () => {
      alive = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [productId, ready, colorsKey, hasCardKey, generation, loadKey]);

  // Erro e sucesso nunca ficam os dois na tela: o último fala.
  function showError(message: string) {
    setDone(undefined);
    setError(message);
  }
  function showDone(message: string) {
    setError(undefined);
    setDone(message);
  }

  /** O que este carregamento não conseguiu trazer, dito uma vez, sem esconder outro erro. */
  const loadError =
    files.complete && files.missing.length > 0
      ? !files.post && !files.story
        ? "Não consegui carregar as imagens. Recarregue a página ou entre de novo."
        : `Não consegui carregar ${files.missing.join(", ")} — toque em Atualizar para tentar de novo.`
      : undefined;

  async function handleGenerate() {
    setBusy(true);
    setError(undefined);
    setWarning(undefined);
    setDone(undefined);
    try {
      const result = await generateProductPostAction({}, productId);
      if (result.error) {
        showError(result.error);
        return;
      }
      showDone(result.success ?? "Pronto.");
      setWarning(result.warning);
      setReady(true);
      setGeneration((current) => current + 1);
    } catch {
      showError(
        "Demorou demais ou a rede caiu — toque em Gerar de novo; o que já ficou pronto não é refeito.",
      );
    } finally {
      setBusy(false);
    }
  }

  function downloadHint(which: "main" | "carousel"): string {
    if (isIphone()) {
      return "Segure a miniatura, escolha “Salvar em Fotos” e monte o post no Instagram.";
    }
    return which === "carousel"
      ? "Toque em “Baixar” embaixo de cada cor e escolha as fotos no Instagram."
      : "Toque em Baixar e escolha as fotos no Instagram.";
  }

  async function handleShare(which: "main" | "carousel") {
    const assets = which === "carousel" ? files.carousel : [files.post, files.story];
    const list = assets.filter((asset): asset is Asset => asset !== null).map((asset) => asset.file);
    if (list.length === 0) {
      showError(
        loadingFiles
          ? "As imagens ainda estão chegando — aguarde um instante e toque de novo."
          : which === "carousel"
            ? "O carrossel ainda não está desenhado. Toque em Atualizar."
            : "Não consegui preparar as imagens para compartilhar. Use “Baixar”.",
      );
      return;
    }
    // Carrossel pela metade: vai o que tem, mas a dona fica sabendo o que faltou.
    if (which === "carousel" && list.length < carousel.length) {
      const left = carousel.filter((_, index) => files.carousel[index] === null).map((entry) => entry.color);
      setWarning(`Ficaram de fora do carrossel: ${left.join(", ")}.`);
    }
    const data: ShareData = { files: list, text: caption };
    if (typeof navigator.canShare === "function" && navigator.canShare(data)) {
      try {
        await navigator.share(data);
        showDone("Compartilhado.");
      } catch (shareError) {
        // A pessoa fechou a folha de compartilhamento: nada a dizer. Qualquer
        // outra recusa é erro de verdade e a tela precisa dizer o que fazer.
        if (shareError instanceof DOMException && shareError.name === "AbortError") return;
        showError(
          `Não consegui abrir o compartilhamento com ${list.length} ${list.length === 1 ? "imagem" : "imagens"}. ${downloadHint(which)}`,
        );
      }
      return;
    }
    showError(`Este aparelho não compartilha imagem direto. ${downloadHint(which)}`);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(caption);
      showDone("Legenda copiada.");
    } catch {
      showError("Não consegui copiar. Selecione o texto da legenda e copie à mão.");
    }
  }

  /** Cores que a tela sabe que ainda não foram desenhadas (não é falha de rede). */
  const missingCards = carousel.filter((_, index) => !expectsCard(index));
  const thumbClass = "w-full rounded-md border border-zinc-200 dark:border-zinc-800";
  const placeholderClass =
    "flex w-full items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-1 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";
  const downloadClass =
    "text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";
  const placeholderText = (expected: boolean) =>
    !expected ? "Sem cartão" : loadingFiles ? "Carregando…" : "Não carregou";

  return (
    <div className="flex flex-col gap-6">
      <Card title="As imagens">
        <div className="flex flex-col gap-4">
          {ready ? (
            <div className="grid grid-cols-2 gap-4">
              <figure className="flex flex-col gap-1">
                {files.post ? (
                  <img src={files.post.url} alt="Post da peça" className={thumbClass} />
                ) : (
                  <div className={placeholderClass} style={{ aspectRatio: "4 / 5" }}>
                    {placeholderText(true)}
                  </div>
                )}
                <figcaption className="text-xs text-zinc-500 dark:text-zinc-400">
                  Post 4:5 (feed)
                </figcaption>
              </figure>
              <figure className="flex flex-col gap-1">
                {files.story ? (
                  <img src={files.story.url} alt="Story da peça" className={thumbClass} />
                ) : (
                  <div className={placeholderClass} style={{ aspectRatio: "9 / 16" }}>
                    {placeholderText(true)}
                  </div>
                )}
                <figcaption className="text-xs text-zinc-500 dark:text-zinc-400">
                  Story 9:16
                </figcaption>
              </figure>
            </div>
          ) : (
            <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Toque em “Gerar” para desenhar o post e o story desta peça. Leva
              alguns segundos na primeira vez; depois é instantâneo.
            </p>
          )}

          {ready && carousel.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Carrossel das cores
              </p>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {carousel.map((entry, index) => (
                  <figure key={entry.color} className="flex w-24 shrink-0 flex-col gap-1">
                    {files.carousel[index] ? (
                      <img
                        src={files.carousel[index]?.url}
                        alt={`Post da cor ${entry.color}`}
                        className={thumbClass}
                      />
                    ) : (
                      <div className={placeholderClass} style={{ aspectRatio: "4 / 5" }}>
                        {placeholderText(expectsCard(index))}
                      </div>
                    )}
                    <figcaption className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {entry.color}
                    </figcaption>
                    {files.carousel[index] ? (
                      <a
                        href={`/admin/produtos/${productId}/post/carousel-${index}?download=1`}
                        className="text-xs font-medium text-zinc-600 underline dark:text-zinc-400"
                      >
                        Baixar
                      </a>
                    ) : null}
                  </figure>
                ))}
              </div>
              {missingCards.length > 0 ? (
                <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
                  {missingCards.length === 1
                    ? `A cor ${missingCards[0].color} ainda não tem cartão — toque em Atualizar. Se continuar sem, a foto dessa cor não abre: suba a foto de novo na tela da peça.`
                    : `As cores ${missingCards.map((entry) => entry.color).join(", ")} ainda não têm cartão — toque em Atualizar. Se continuarem sem, a foto delas não abre: suba as fotos de novo na tela da peça.`}
                </p>
              ) : null}
              {omittedColors.length > 0 ? (
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  O Instagram aceita 10 imagens por carrossel; ficaram de fora:{" "}
                  {omittedColors.join(", ")}.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleGenerate} disabled={busy}>
              {busy ? "Desenhando…" : ready ? "Atualizar" : "Gerar"}
            </Button>
            {ready ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleShare("main")}
                  disabled={loadingFiles}
                >
                  {loadingFiles ? "Preparando as imagens…" : "Compartilhar"}
                </Button>
                {carousel.length > 0 ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleShare("carousel")}
                    disabled={loadingFiles}
                  >
                    Só o carrossel
                  </Button>
                ) : null}
                <a href={`/admin/produtos/${productId}/post/post?download=1`} className={downloadClass}>
                  Baixar o post
                </a>
                <a href={`/admin/produtos/${productId}/post/story?download=1`} className={downloadClass}>
                  Baixar o story
                </a>
              </>
            ) : null}
          </div>

          <FormError message={error ?? loadError} />
          {warning ? (
            <p className="text-sm leading-relaxed text-amber-900 dark:text-amber-100">{warning}</p>
          ) : null}
          <FormSuccess message={done} />
        </div>
      </Card>

      <Card title="A legenda">
        <div className="flex flex-col gap-3">
          <TextArea readOnly rows={10} value={caption} aria-label="Legenda do post" />
          <div>
            <Button type="button" variant="outline" onClick={handleCopy}>
              Copiar legenda
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
