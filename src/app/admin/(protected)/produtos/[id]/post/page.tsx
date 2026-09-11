import type { Metadata } from "next";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getFileStorage } from "@/adapters/storage";
import { getDb } from "@/db/client";
import { notFound } from "next/navigation";
import { z } from "zod";

import { requireUser } from "@/services/auth";
import { getProductPostPreview } from "@/services/product-posts";
import { ServiceError } from "@/services/settings";

import { SharePost } from "./share-post";

export const dynamic = "force-dynamic";
/** O desenho do post e do story roda dentro da action desta página. */
export const maxDuration = 60;

export const metadata: Metadata = { title: "Post da peça" };

export default async function PostDaPecaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  let preview;
  let blocked: string | null = null;
  try {
    preview = await getProductPostPreview(getDb(), getFileStorage(), id);
  } catch (error) {
    if (error instanceof ServiceError) {
      if (error.code === "nao_encontrado") notFound();
      blocked = error.message;
    } else throw error;
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Post da peça"
        subtitle="O post 4:5 e o story 9:16 na identidade da maison, com a legenda pronta para colar."
        actions={
          <Link
            href={`/admin/produtos/${id}`}
            className="text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400"
          >
            Voltar para a peça
          </Link>
        }
      />

      {blocked ? (
        <Card>
          <p className="text-sm leading-relaxed text-amber-900 dark:text-amber-100">{blocked}</p>
        </Card>
      ) : (
        <SharePost
          productId={id}
          caption={preview!.caption}
          hasPost={preview!.post !== null}
          hasStory={preview!.story !== null}
          colors={preview!.carousel.map((entry) => entry.color)}
        />
      )}
    </div>
  );
}
