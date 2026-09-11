// Placa de museu: composição, cuidados (pictogramas com rótulo) e como veste.
// Server component; some quando a peça não tem ficha.
import type { ReactNode } from "react";
import {
  CARE_SYMBOLS,
  careNotesToLabels,
  parseCareNotes,
  type CareSymbolKey,
} from "@/core/catalog/care";
import {
  IconDryClean,
  IconDryShade,
  IconHandWash,
  IconIronLow,
  IconMachineCold,
  IconNoBleach,
  IconNoIron,
  IconNoTumble,
} from "./icons";

const CARE_ICONS: Record<CareSymbolKey, (props: { className?: string }) => ReactNode> = {
  hand_wash: IconHandWash,
  machine_cold: IconMachineCold,
  no_bleach: IconNoBleach,
  dry_shade: IconDryShade,
  iron_low: IconIronLow,
  no_iron: IconNoIron,
  dry_clean: IconDryClean,
  no_tumble: IconNoTumble,
};

export type MuseumPlaqueData = {
  composition: string | null;
  careNotes: string | null;
  fitNotes: string | null;
};

export function hasMuseumPlaque(data: MuseumPlaqueData): boolean {
  return Boolean(data.composition?.trim() || data.careNotes?.trim() || data.fitNotes?.trim());
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="font-store text-eyebrow font-medium text-ink-500 uppercase">{label}</dt>
      <dd className="font-store text-[15px] leading-7 text-ink-700">{children}</dd>
    </div>
  );
}

export function MuseumPlaque({ data }: { data: MuseumPlaqueData }) {
  const care = parseCareNotes(data.careNotes);
  const careLabels = careNotesToLabels(care);
  return (
    <dl className="divide-y divide-ivory-300">
      {data.composition?.trim() ? <Row label="Composição">{data.composition.trim()}</Row> : null}
      {careLabels.length > 0 ? (
        <Row label="Cuidados">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            {care.symbols.map((key) => {
              const Icon = CARE_ICONS[key];
              return (
                <li key={key} className="flex items-center gap-2">
                  <Icon className="h-5 w-5 shrink-0 text-gold-700" />
                  <span>{CARE_SYMBOLS[key].label}</span>
                </li>
              );
            })}
            {care.freeText.map((line) => (
              <li key={line} className="basis-full">
                {line}
              </li>
            ))}
          </ul>
        </Row>
      ) : null}
      {data.fitNotes?.trim() ? (
        <Row label="Como veste">
          <p className="whitespace-pre-line">{data.fitNotes.trim()}</p>
        </Row>
      ) : null}
    </dl>
  );
}
