// 404 da maison: vale para URL inexistente (via [...rest]) e para produto ou
// pedido que não existe (notFound() nas páginas). Mostra as salas para a
// pessoa não sair de mãos vazias.
import Link from "next/link";

import { CategoryIndex } from "@/components/store/category-index";
import { Ribbon } from "@/components/store/ribbon";
import { btnPrimary, eyebrow } from "@/components/store/styles";
import { getDb } from "@/db/client";
import { tryOrBuildFallback } from "@/lib/build-safe";
import { listPublicCategories } from "@/services/store-catalog";

export default async function StoreNotFound() {
  const categories = await tryOrBuildFallback([], () =>
    listPublicCategories(getDb()),
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center gap-6 px-4 py-20 text-center">
      <p className={eyebrow}>Página não encontrada</p>
      <h1 className="font-display text-title font-semibold text-balance text-espresso-900">
        Essa porta não existe na maison
      </h1>
      <Ribbon variant="static" size="sm" />
      <p className="w-full max-w-md text-[15px] leading-7 text-ink-700">
        O endereço pode ter mudado ou chegado incompleto. Volte para a coleção
        ou entre em uma das salas.
      </p>
      <Link href="/produtos" className={btnPrimary}>
        Ver a coleção
      </Link>
      {categories.length > 0 ? (
        <CategoryIndex categories={categories} compact className="mt-6" />
      ) : null}
    </div>
  );
}
