// Embalagem — selos e adesivos: o SELO redondo de 50 mm (logotipo + slogan)
// que fecha o papel da peça e o ADESIVO DA SACOLA de 15 × 10 cm (a marca em
// destaque + QR para a Lia, WhatsApp, Instagram e site). Duas impressões:
// papel adesivo A4 comum (corte na tesoura pela linha-guia/marcas) e
// Silhouette Portrait (a folha sai daqui com as marcas de registro; no
// Studio um arquivo de corte salvo uma vez). O form é GET: escolher só
// recarrega, não grava nada.
import type { Metadata } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import Link from "next/link";
import { z } from "zod";

import { PrintButton } from "@/components/admin/print-button";
import { LetteringSymbols } from "@/components/print/brand-lettering";
import { DxfDownloadButton } from "@/components/print/dxf-download";
import { printCss } from "@/components/print/print-css";
import { Button, Input, Select } from "@/components/ui/form";
import { PAGE_A4, silhouetteSafeArea } from "@/core/catalog/silhouette";
import {
  BAG_STICKER,
  gridPositions,
  PLAIN_SHEET_MARGIN_MM,
  printableArea,
  rectLabelCutDxf,
  roundLabelCutDxf,
  roundLabelPositions,
  SEAL,
} from "@/core/print/round-labels";
import { getDb } from "@/db/client";
import { DEFAULT_SELLER_NAME } from "@/core/bot/prompt";
import { STORE_HERO_LINE_DEFAULT, STORE_INSTAGRAM_DEFAULT, STORE_NAME_DEFAULT } from "@/lib/brand";
import { waMeUrl } from "@/lib/phone";
import { siteUrl } from "@/lib/site-url";
import { qrSvgPath, qrVersion } from "@/receipts/qr";
import { requireUser } from "@/services/auth";
import { getSettingsMap } from "@/services/settings";

import { BagQrSymbol, BagStickerSheet, STORE_LINE_MAX_CHARS, type BagStickerData } from "./bag-sticker";
import { SealSheet } from "./seal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Embalagem: selos e adesivos" };

// As fontes da marca (as mesmas da vitrine): o painel usa Geist, o selo não.
const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});
const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  preload: false,
});

const MAX_SHEETS = 10;
const modelParam = z.enum(["selo", "sacola"]).catch("selo");
const formatParam = z.enum(["a4", "silhouette"]).catch("a4");
// Fora da faixa pela URL: encosta no limite em vez de cair para 1.
const sheetsParam = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), MAX_SHEETS) : 1))
  .catch(1);

type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const asText = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export default async function PackagingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireUser();
  const sp = await searchParams;
  const model = modelParam.parse(first(sp.modelo));
  const format = formatParam.parse(first(sp.formato));
  const sheets = sheetsParam.parse(first(sp.folhas));
  const settings = await getSettingsMap(getDb(), ["store_name", "store_tagline", "store_whatsapp", "store_instagram", "bot_seller_name"]);
  const storeName = asText(settings.store_name) || STORE_NAME_DEFAULT;
  const sellerName = asText(settings.bot_seller_name) || DEFAULT_SELLER_NAME;

  const silhouette = format === "silhouette";
  const mode = silhouette ? "silhouette" : "scissors";
  const area = silhouette ? silhouetteSafeArea(PAGE_A4) : printableArea(PAGE_A4, PLAIN_SHEET_MARGIN_MM);
  // Na Silhouette a grade centra na ALTURA da página: um DXF que entre
  // invertido no Y no Studio cai nas mesmas posições.
  const centerIn = silhouette ? { xMm: area.xMm, yMm: 0, widthMm: area.widthMm, heightMm: PAGE_A4.heightMm } : area;

  const bag = model === "sacola";
  const sealPositions = bag ? [] : roundLabelPositions({ diameterMm: SEAL.diameterMm, gapMm: SEAL.gapMm, area, centerIn });
  const bagPositions = bag ? gridPositions({ cellWidthMm: BAG_STICKER.widthMm, cellHeightMm: BAG_STICKER.heightMm, gapMm: BAG_STICKER.gapMm, area, centerIn }) : [];
  const perSheet = bag ? bagPositions.length : sealPositions.length;
  const cutDxf = !silhouette
    ? null
    : bag
      ? rectLabelCutDxf({ page: PAGE_A4, positions: bagPositions, widthMm: BAG_STICKER.widthMm, heightMm: BAG_STICKER.heightMm, cornerRadiusMm: BAG_STICKER.cornerRadiusMm })
      : roundLabelCutDxf({ page: PAGE_A4, positions: sealPositions, diameterMm: SEAL.diameterMm });
  const dxfFileName = bag ? "adesivo-sacola-corte-silhouette.dxf" : "selos-corte-silhouette.dxf";
  const studioFile = bag ? "TRIVÉ sacola.studio3" : "TRIVÉ selos.studio3";

  // O adesivo da sacola: o QR leva à Lia no WhatsApp da loja.
  const whatsappE164 = asText(settings.store_whatsapp) || null;
  const qrText = whatsappE164 ? waMeUrl(whatsappE164, `Oi, ${sellerName}! Vim pela sacola da ${storeName}`) : null;
  const qr = qrText ? qrSvgPath(qrText) : null;
  const bagData: BagStickerData = {
    storeName,
    // A frase da vitrine só entra se couber na coluna (até 90 chars); senão a frase padrão da marca.
    storeLine: [asText(settings.store_tagline)].filter((line) => line.length > 0 && line.length <= STORE_LINE_MAX_CHARS)[0] ?? STORE_HERO_LINE_DEFAULT,
    whatsappE164,
    instagram: asText(settings.store_instagram) || STORE_INSTAGRAM_DEFAULT,
    siteHost: siteUrl().replace(/^https?:\/\//, ""),
    sellerName,
  };
  const warnings: string[] = [];
  if (bag && !whatsappE164) warnings.push("O WhatsApp da loja não está preenchido em Configurações → Dados da loja: o adesivo sai sem o QR e sem o telefone.");
  if (bag && qrText && qrVersion(qrText) > 7) warnings.push("O link do WhatsApp ficou longo e o QR denso demais para 28 mm — encurte o nome da loja.");
  if (bag && asText(settings.store_tagline).length > STORE_LINE_MAX_CHARS) warnings.push(`A frase da vitrine tem mais de ${STORE_LINE_MAX_CHARS} caracteres e não cabe no adesivo: saiu a frase padrão da marca.`);

  const unit = bag ? "adesivo" : "selo";
  const units = bag ? "adesivos" : "selos";

  return (
    <div className="flex flex-col gap-6">
      <style>{printCss("A4")}</style>

      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Link href="/admin/produtos" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
            ← Produtos
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Embalagem: selos e adesivos</h1>
          <p className="max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            {bag
              ? `Adesivo da sacola, ${BAG_STICKER.widthMm / 10} × ${BAG_STICKER.heightMm / 10} cm: a marca em destaque, QR para a Lia, WhatsApp, Instagram e site. `
              : `Selo redondo de ${SEAL.diameterMm} mm com o logotipo e o slogan, para fechar o papel que embala a peça. `}
            {silhouette
              ? `Folha A4 com ${perSheet} ${units} dentro da área que as marcas de registro do Studio deixam livre — impressa aqui já com as marcas; a plotter corta.`
              : bag
                ? `Folha A4 de papel adesivo com ${perSheet} adesivos (o máximo que cabe); corte pelas marcas dos cantos, com régua e estilete.`
                : `Folha A4 de papel adesivo com ${perSheet} selos; corte pela linha cinza fina (tesoura ou furador de círculo de 2″).`}
          </p>
        </div>
        <PrintButton label={sheets === 1 ? "Imprimir 1 folha" : `Imprimir ${sheets} folhas`} />
      </div>

      {warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 print:hidden dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <form method="get" className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 print:hidden dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Modelo</span>
            <Select name="modelo" defaultValue={model}>
              <option value="selo">Selo redondo — 50 mm, logotipo e slogan</option>
              <option value="sacola">Adesivo da sacola — 15 × 10 cm, marca + contatos + QR</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Impressão</span>
            <Select name="formato" defaultValue={format}>
              <option value="a4">Papel adesivo A4 comum — corte na tesoura</option>
              <option value="silhouette">Silhouette Portrait — imprime aqui com marcas de registro, corta no Studio</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">Folhas</span>
            <div className="w-24">
              <Input name="folhas" type="number" inputMode="numeric" min={1} max={MAX_SHEETS} defaultValue={sheets} />
            </div>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit">Atualizar</Button>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {sheets} {sheets === 1 ? "folha" : "folhas"} × {perSheet} = <strong>{sheets * perSheet} {sheets * perSheet === 1 ? unit : units}</strong>.
          </span>
        </div>
      </form>

      {silhouette ? (
        <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Cortar na Silhouette</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              O arquivo de corte é o mesmo para toda folha: os {perSheet} {bag ? "retângulos de cantos arredondados" : "círculos"} ficam sempre no mesmo lugar. Papel adesivo A4 na bandeja de trás, lado do adesivo para cima. Na caixa de diálogo do sistema: tamanho <strong>A4</strong>, escala <strong>100 %</strong>, frente e verso <strong>desmarcado</strong>, qualidade <strong>normal ou alta</strong> (no rascunho as marcas saem claras e a plotter não lê); tipo de papel conforme o adesivo — <em>Papel comum</em> no adesivo comum sem revestimento, <em>Premium Presentation Paper Matte</em> no fotográfico fosco, <em>Photo Paper Glossy</em> no brilhante.
            </p>
          </div>
          {cutDxf ? <DxfDownloadButton dxf={cutDxf} fileName={dxfFileName} /> : null}
          <div>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Primeira vez (uma vez só)</h3>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
              <li>
                Baixe o <strong>arquivo de corte (DXF)</strong>. No <strong>Silhouette Studio</strong>: <em>Preferências</em> → unidades em <strong>mm</strong>; em <em>Importação</em>, DXF <strong>&ldquo;As Is&rdquo;</strong>.
              </li>
              <li>
                Abra o DXF. <em>Configuração de página</em>: tamanho <strong>A4</strong>, base de corte <em>Portrait</em>; <strong>marcas de registro ligadas</strong>, em <em>Restaurar padrões</em> (recuos 15,9 mm e 26 mm embaixo, comprimento 20 mm, espessura 0,5 mm). Selecione tudo, confira <strong>210 × 297 mm</strong> no <em>Transformar</em>, ponto de referência no canto superior esquerdo → <strong>X 0, Y 0</strong> → apague o retângulo grande (camada PAGINA). Os contornos devem cair na área sem hachura, longe das marcas, com a mesma folga em cima e embaixo (a grade é centrada na altura da folha — se o DXF entrar invertido, ela cai no mesmo lugar).
              </li>
              <li>
                <em>Salvar como</em> <strong>&ldquo;{studioFile}&rdquo;</strong>.
              </li>
            </ol>
          </div>
          <div>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Cada vez</h3>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
              <li>Folha impressa na base de corte, com as marcas para cima e o quadrado no canto da seta, cobrindo a linha preta da grade.</li>
              <li>
                Abra <strong>&ldquo;{studioFile}&rdquo;</strong> → <em>Enviar</em> → material <strong>Papel adesivo</strong> (<em>Sticker Paper</em>), AutoBlade. É um corte <strong>&ldquo;kiss cut&rdquo;</strong>: só o adesivo, a base fica inteira e os {units} saem descolando. Comece com a força baixa numa folha de teste e suba até o adesivo soltar sem marcar a base.
              </li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm print:hidden dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">Como imprimir</h2>
          <ol className="list-decimal space-y-2 pl-5 text-zinc-700 dark:text-zinc-300">
            <li>
              Papel adesivo A4 (fosco fica mais elegante e não reflete) na bandeja de trás, lado do adesivo para cima. Na caixa de diálogo do sistema: tamanho <strong>A4</strong>, escala <strong>100 %</strong>, frente e verso desmarcado, qualidade <strong>alta</strong>; tipo de papel conforme o adesivo — <em>Papel comum</em> no adesivo comum sem revestimento (o mais vendido), <em>Premium Presentation Paper Matte</em> no fotográfico fosco, <em>Photo Paper Glossy</em> no brilhante.
            </li>
            <li>
              {bag ? (
                <>
                  Corte pelas <strong>marcas dos cantos</strong> com régua e estilete (ou tesoura). O marfim vai 1 mm além das marcas: cortar um pouco fora não deixa borda branca.
                </>
              ) : (
                <>
                  Corte pela <strong>linha cinza fina</strong> em volta de cada selo — tesoura, ou um <strong>furador de círculo de 2&Prime; (50,8 mm)</strong>, o de scrapbook, para sair redondinho de uma vez. O marfim vai 1 mm além da linha: cortar um pouco fora não deixa borda branca.
                </>
              )}
            </li>
            <li>
              Quer o corte perfeito sem tesoura? Troque para <strong>Silhouette Portrait</strong> acima.
            </li>
          </ol>
        </div>
      )}

      <div className={`print-area flex flex-col gap-6 overflow-x-auto rounded-lg bg-zinc-100 p-6 dark:bg-zinc-950 ${cormorant.variable} ${jost.variable}`}>
        {/* Símbolos usados por todos os adesivos da página (letreiro, tagline e o QR): uma vez, nunca display:none. */}
        <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", overflow: "hidden" }}>
          <defs>
            <LetteringSymbols />
            {qr ? <BagQrSymbol qr={qr} /> : null}
          </defs>
        </svg>
        {Array.from({ length: sheets }, (_, index) =>
          bag ? (
            <BagStickerSheet key={index} positions={bagPositions} data={bagData} mode={mode} index={index + 1} total={sheets} />
          ) : (
            <SealSheet key={index} positions={sealPositions} storeName={storeName} mode={mode} index={index + 1} total={sheets} />
          ),
        )}
      </div>
    </div>
  );
}
