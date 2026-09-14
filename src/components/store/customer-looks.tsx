// "Quem já vestiu": as fotos das clientes com a peça, só apresentação. As
// fotos são JPEG já normalizados (≤ 1600 px) no Storage; <img> nativo como
// nas demais fotos da vitrine. Só o primeiro nome aparece.
import { SectionHeading } from "@/components/store/section-heading";

export type CustomerLookView = { id: string; displayName: string; url: string };

export function CustomerLooks({ productName, looks }: { productName: string; looks: CustomerLookView[] }) {
  if (looks.length === 0) return null;
  return (
    <section aria-labelledby="quem-vestiu" className="mt-16">
      <SectionHeading eyebrow="Quem já vestiu" title="Nas clientes da maison" id="quem-vestiu" />
      <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-4">
        {looks.map((look) => (
          <li key={look.id} className="flex flex-col gap-2">
            <div className="overflow-hidden rounded-(--radius-hair) bg-ivory-200">
              <img
                src={look.url}
                alt={`${look.displayName} veste ${productName}`}
                width={600}
                height={800}
                loading="lazy"
                decoding="async"
                className="aspect-[3/4] w-full object-cover"
              />
            </div>
            <p className="font-store text-sm text-ink-700">
              {look.displayName} veste {productName}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-4 font-store text-xs text-ink-500">Fotos enviadas pelas clientes, com o consentimento delas.</p>
    </section>
  );
}
