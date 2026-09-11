"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button, FormError, FormSuccess, TextArea } from "@/components/ui/form";

import { generateProductPostAction } from "./actions";

type Loaded = { post: File | null; story: File | null };

/**
 * A tela do post: prévia, Compartilhar (a folha do sistema com as duas
 * imagens, no celular), Baixar quando o aparelho não compartilha arquivo, e
 * Copiar legenda. As imagens vêm por uma rota da própria origem — o
 * compartilhamento precisa do arquivo em memória, não de uma URL de outro
 * domínio.
 */
export function SharePost({
  productId,
  caption,
  hasPost,
  hasStory,
}: {
  productId: string;
  caption: string;
  hasPost: boolean;
  hasStory: boolean;
}) {
  const [ready, setReady] = useState(hasPost && hasStory);
  const [files, setFiles] = useState<Loaded>({ post: null, story: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  const load = useCallback(async (): Promise<Loaded> => {
    const fetchOne = async (format: "post" | "story"): Promise<File | null> => {
      const response = await fetch(`/admin/produtos/${productId}/post/${format}`);
      if (!response.ok) return null;
      const blob = await response.blob();
      return new File([blob], `${format}.jpg`, { type: "image/jpeg" });
    };
    const [post, story] = await Promise.all([fetchOne("post"), fetchOne("story")]);
    return { post, story };
  }, [productId]);

  // As imagens já desenhadas entram em memória assim que a tela abre: é o
  // arquivo, não a URL, que o compartilhamento do celular precisa.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void load().then((loaded) => {
      if (alive) setFiles(loaded);
    });
    return () => {
      alive = false;
    };
  }, [ready, load]);

  async function handleGenerate() {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    const result = await generateProductPostAction({}, productId);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setReady(true);
    setDone("Post e story prontos.");
    setFiles(await load());
  }

  async function handleShare() {
    const list = [files.post, files.story].filter((file): file is File => file !== null);
    if (list.length === 0) return;
    const data: ShareData = { files: list, text: caption };
    if (typeof navigator.canShare === "function" && navigator.canShare(data)) {
      try {
        await navigator.share(data);
        return;
      } catch {
        // A pessoa fechou a folha de compartilhamento: nada a dizer.
        return;
      }
    }
    setError(
      "Este aparelho não compartilha imagem direto. Toque em Baixar e escolha as fotos no Instagram.",
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

  return (
    <div className="flex flex-col gap-6">
      <Card title="As imagens">
        <div className="flex flex-col gap-4">
          {ready ? (
            <div className="grid grid-cols-2 gap-4">
              <figure className="flex flex-col gap-1">
                <Image
                  src={`/admin/produtos/${productId}/post/post`}
                  alt="Post da peça"
                  width={1080}
                  height={1350}
                  unoptimized
                  className="w-full rounded-md border border-zinc-200 dark:border-zinc-800"
                />
                <figcaption className="text-xs text-zinc-500 dark:text-zinc-400">
                  Post 4:5 (feed)
                </figcaption>
              </figure>
              <figure className="flex flex-col gap-1">
                <Image
                  src={`/admin/produtos/${productId}/post/story`}
                  alt="Story da peça"
                  width={1080}
                  height={1920}
                  unoptimized
                  className="w-full rounded-md border border-zinc-200 dark:border-zinc-800"
                />
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

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleGenerate} disabled={busy}>
              {busy ? "Desenhando…" : ready ? "Atualizar" : "Gerar"}
            </Button>
            {ready ? (
              <>
                <Button type="button" variant="outline" onClick={handleShare}>
                  Compartilhar
                </Button>
                <a
                  href={`/admin/produtos/${productId}/post/post?download=1`}
                  className="text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Baixar o post
                </a>
                <a
                  href={`/admin/produtos/${productId}/post/story?download=1`}
                  className="text-sm font-medium text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  Baixar o story
                </a>
              </>
            ) : null}
          </div>

          <FormError message={error} />
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
