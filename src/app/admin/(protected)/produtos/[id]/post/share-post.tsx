"use client";

import { useEffect, useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button, FormError, FormSuccess, TextArea } from "@/components/ui/form";

import { generateProductPostAction } from "./actions";

export type CarouselColor = {
  color: string;
  /** Já tem cartão no cache (o pré-desenho ou um "Gerar" anterior). */
  hasCard: boolean;
};

type Loaded = {
  /** A qual carregamento estes arquivos pertencem (cores + geração). */
  key: string;
  post: File | null;
  story: File | null;
  carousel: (File | null)[];
  /** Todos os downloads terminaram (com ou sem sucesso). */
  complete: boolean;
};
type Previews = { post: string | null; story: string | null; carousel: (string | null)[] };

function emptyLoaded(key: string, colorCount: number): Loaded {
  return { key, post: null, story: null, carousel: Array.from({ length: colorCount }, () => null), complete: false };
}

const KEY_SEPARATOR = "\u001f";

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

  // As imagens já desenhadas entram em memória assim que a tela abre, cada
  // uma no seu tempo (a miniatura aparece conforme chega).
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const colors = colorsKey === "" ? [] : colorsKey.split(KEY_SEPARATOR);
    const fresh = () => emptyLoaded(loadKey, colors.length);
    const patch = (change: (prev: Loaded) => Partial<Loaded>) =>
      setLoaded((prev) => {
        const base = prev.key === loadKey ? prev : fresh();
        return { ...base, ...change(base) };
      });
    const fetchOne = async (format: string): Promise<File | null> => {
      try {
        const response = await fetch(`/admin/produtos/${productId}/post/${format}`, {
          cache: "no-store",
        });
        // Sessão expirada responde a página de login (200, text/html): sem esta
        // checagem o "JPEG" compartilhado seria o HTML do login.
        if (!response.ok || response.redirected) return null;
        const blob = await response.blob();
        if (!blob.type.startsWith("image/")) return null;
        return new File([blob], `${format}.jpg`, { type: "image/jpeg" });
      } catch {
        // Rede que caiu no meio: a imagem fica de fora e a tela diz o que fazer.
        return null;
      }
    };

    const postTask = fetchOne("post");
    const storyTask = fetchOne("story");
    const colorTasks = colors.map((_, index) =>
      hasCardKey === "all" || hasCardKey[index] === "1"
        ? fetchOne(`carousel-${index}`)
        : Promise.resolve<File | null>(null),
    );
    void postTask.then((file) => {
      if (alive) patch(() => ({ post: file }));
    });
    void storyTask.then((file) => {
      if (alive) patch(() => ({ story: file }));
    });
    colorTasks.forEach((task, index) => {
      void task.then((file) => {
        if (!alive) return;
        patch((prev) => {
          const next = [...prev.carousel];
          next[index] = file;
          return { carousel: next };
        });
      });
    });
    void Promise.all([postTask, storyTask, ...colorTasks]).then(([post, story]) => {
      if (!alive) return;
      patch(() => ({ complete: true }));
      if (!post && !story) {
        setError("Não consegui carregar as imagens. Recarregue a página ou entre de novo.");
      }
    });
    return () => {
      alive = false;
    };
  }, [productId, ready, colorsKey, hasCardKey, generation, loadKey]);

  // Miniaturas a partir dos arquivos já baixados (nada de segundo download);
  // as URLs de objeto são liberadas quando trocam.
  const previews = useMemo<Previews>(
    () => ({
      post: files.post ? URL.createObjectURL(files.post) : null,
      story: files.story ? URL.createObjectURL(files.story) : null,
      carousel: files.carousel.map((file) => (file ? URL.createObjectURL(file) : null)),
    }),
    [files],
  );
  useEffect(
    () => () => {
      for (const url of [previews.post, previews.story, ...previews.carousel]) {
        if (url) URL.revokeObjectURL(url);
      }
    },
    [previews],
  );

  async function handleGenerate() {
    setBusy(true);
    setError(undefined);
    setWarning(undefined);
    setDone(undefined);
    try {
      const result = await generateProductPostAction({}, productId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setDone(result.success);
      setWarning(result.warning);
      setReady(true);
      setGeneration((current) => current + 1);
    } catch {
      setError(
        "Demorou demais ou a rede caiu — toque em Gerar de novo; o que já ficou pronto não é refeito.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleShare(which: "main" | "carousel") {
    const list = (which === "carousel" ? files.carousel : [files.post, files.story]).filter(
      (file): file is File => file !== null,
    );
    if (list.length === 0) {
      setError(
        loadingFiles
          ? "As imagens ainda estão chegando — aguarde um instante e toque de novo."
          : which === "carousel"
            ? "O carrossel ainda não está desenhado. Toque em Atualizar."
            : "Não consegui preparar as imagens para compartilhar. Use “Baixar”.",
      );
      return;
    }
    const data: ShareData = { files: list, text: caption };
    if (typeof navigator.canShare === "function" && navigator.canShare(data)) {
      try {
        await navigator.share(data);
        setDone("Compartilhado.");
      } catch (shareError) {
        // A pessoa fechou a folha de compartilhamento: nada a dizer. Qualquer
        // outra recusa é erro de verdade e a tela precisa dizer o que fazer.
        if (shareError instanceof DOMException && shareError.name === "AbortError") return;
        setError(
          `Não consegui abrir o compartilhamento com ${list.length} ${list.length === 1 ? "imagem" : "imagens"}. Use “Baixar” e escolha as fotos no Instagram.`,
        );
      }
      return;
    }
    setError(
      which === "carousel"
        ? "Este aparelho não compartilha imagem direto. Toque em “Baixar” embaixo de cada cor e escolha as fotos no Instagram."
        : "Este aparelho não compartilha imagem direto. Toque em Baixar e escolha as fotos no Instagram.",
    );
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(caption);
      setDone("Legenda copiada.");
    } catch {
      setError("Não consegui copiar. Selecione o texto da legenda e copie à mão.");
    }
  }

  const missingCards = carousel.filter(
    (entry, index) => !(hasCardKey === "all" || entry.hasCard) && files.carousel[index] === null,
  );
  const thumbClass = "w-full rounded-md border border-zinc-200 dark:border-zinc-800";
  const placeholderClass =
    "flex w-full items-center justify-center rounded-md border border-dashed border-zinc-300 bg-zinc-50 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400";
  const downloadClass =
    "text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100";

  return (
    <div className="flex flex-col gap-6">
      <Card title="As imagens">
        <div className="flex flex-col gap-4">
          {ready ? (
            <div className="grid grid-cols-2 gap-4">
              <figure className="flex flex-col gap-1">
                {previews.post ? (
                  <img src={previews.post} alt="Post da peça" className={thumbClass} />
                ) : (
                  <div className={placeholderClass} style={{ aspectRatio: "4 / 5" }}>
                    {loadingFiles ? "Carregando…" : "Sem imagem"}
                  </div>
                )}
                <figcaption className="text-xs text-zinc-500 dark:text-zinc-400">
                  Post 4:5 (feed)
                </figcaption>
              </figure>
              <figure className="flex flex-col gap-1">
                {previews.story ? (
                  <img src={previews.story} alt="Story da peça" className={thumbClass} />
                ) : (
                  <div className={placeholderClass} style={{ aspectRatio: "9 / 16" }}>
                    {loadingFiles ? "Carregando…" : "Sem imagem"}
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
                    {previews.carousel[index] ? (
                          <img
                        src={previews.carousel[index] ?? undefined}
                        alt={`Post da cor ${entry.color}`}
                        className={thumbClass}
                      />
                    ) : (
                      <div className={placeholderClass} style={{ aspectRatio: "4 / 5" }}>
                        {loadingFiles && (hasCardKey === "all" || entry.hasCard) ? "Carregando…" : "Sem cartão"}
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
              {missingCards.length > 0 && !loadingFiles ? (
                <p className="text-xs leading-relaxed text-amber-900 dark:text-amber-100">
                  {missingCards.length === 1
                    ? `A cor ${missingCards[0].color} ainda não tem cartão — toque em Atualizar.`
                    : `As cores ${missingCards.map((entry) => entry.color).join(", ")} ainda não têm cartão — toque em Atualizar.`}
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

          <FormError message={error} />
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
