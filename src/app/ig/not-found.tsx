// Slug de story que não existe: um 404 com a cara da maison e uma saída.
import Link from "next/link";

import { Monogram } from "@/components/store/brand/monogram";
import { btnGold } from "@/components/store/styles";

export default function IgNotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-16 text-center">
      <Monogram size={40} tone="gold" />
      <h1 className="font-display text-3xl font-normal leading-tight text-ivory-50">Esse link não está mais no ar</h1>
      <p className="max-w-sm font-store text-sm text-ivory-200/80">O story pode ter saído de cartaz. A coleção continua aberta.</p>
      <Link href="/produtos" className={`${btnGold} w-full max-w-xs`}>
        Ver a coleção
      </Link>
    </main>
  );
}
