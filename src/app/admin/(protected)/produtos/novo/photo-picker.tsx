"use client";

import { useEffect, useRef, type ChangeEvent } from "react";
import { Button, Select } from "@/components/ui/form";

export type PhotoStatus = "pending" | "sent" | "failed";

export type PhotoItem = {
  id: string;
  file: File;
  /** "" = foto do produto inteiro (todas as cores). */
  color: string;
  status: PhotoStatus;
  error?: string;
};

export function PhotoPicker({
  photos,
  colors,
  hint,
  locked,
  onAdd,
  onRemove,
  onColorChange,
}: {
  photos: PhotoItem[];
  /** Cores que vão virar variação — são as únicas que a foto pode receber. */
  colors: string[];
  hint: string;
  /** Depois de o produto ser criado a lista congela: só resta enviar. */
  locked: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onAdd([...(event.target.files ?? [])]);
    // Zerar o input deixa o dono escolher o MESMO arquivo de novo depois de
    // remover — sem isso o navegador não dispara change na segunda vez.
    event.target.value = "";
  }

  return (
    <div className="flex flex-col gap-3">
      {locked ? null : (
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={handleChange}
          className="text-sm text-zinc-600 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-700 hover:file:bg-zinc-100 dark:text-zinc-400 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-300 dark:hover:file:bg-zinc-800"
        />
      )}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>

      {photos.length === 0 ? null : (
        <ul className="flex flex-col gap-2">
          {photos.map((photo) => (
            <li
              key={photo.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-800"
            >
              <PhotoPreview file={photo.file} />

              <div className="min-w-40 flex-1">
                <p className="truncate text-sm text-zinc-800 dark:text-zinc-200">
                  {photo.file.name}
                </p>
                <PhotoStatusLine photo={photo} />
              </div>

              {colors.length > 0 ? (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-medium text-zinc-600 dark:text-zinc-400">
                    De qual cor é esta foto?
                  </span>
                  <Select
                    value={photo.color}
                    disabled={locked}
                    onChange={(event) =>
                      onColorChange(photo.id, event.target.value)
                    }
                  >
                    <option value="">Todas as cores</option>
                    {colors.map((color) => (
                      <option key={color} value={color}>
                        {color}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}

              {locked ? null : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRemove(photo.id)}
                >
                  Remover
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PhotoStatusLine({ photo }: { photo: PhotoItem }) {
  if (photo.status === "sent") {
    return (
      <p className="text-xs text-emerald-600 dark:text-emerald-400">
        Foto enviada.
      </p>
    );
  }
  if (photo.status === "failed") {
    return (
      <p className="text-xs text-red-600 dark:text-red-400">
        Não subiu: {photo.error ?? "erro desconhecido."}
      </p>
    );
  }
  return (
    <p className="text-xs text-zinc-500 dark:text-zinc-400">
      {formatSize(photo.file.size)}
    </p>
  );
}

/**
 * A miniatura vive fora do React: a URL do arquivo escolhido é criada e
 * revogada no efeito e escrita direto no <img>. Guardá-la em estado obrigaria
 * a um render a mais só para mostrar a foto — e, se o cleanup não casasse com
 * a criação, o navegador seguraria cada arquivo na memória até recarregar.
 */
function PhotoPreview({ file }: { file: File }) {
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    const image = imageRef.current;
    if (image) image.src = objectUrl;
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <img
      ref={imageRef}
      alt=""
      className="h-16 w-16 rounded-md border border-zinc-200 bg-zinc-100 object-cover dark:border-zinc-800 dark:bg-zinc-800"
    />
  );
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
