// Links de story: a dona cria "dunas", copia trivemaison.com.br/ig/dunas e
// cola no sticker do story. Quem toca cai no WhatsApp da Lia já falando da
// peça; aqui ela vê quantos tocaram, quantos conversaram e quantos compraram.
import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Td, Tr } from "@/components/ui/table";
import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { listCampaignLinks, type CampaignLink } from "@/services/campaign-links";
import { listProducts } from "@/services/catalog";
import { siteBaseUrl } from "@/services/wa-messaging";

import { toggleCampaignLinkAction } from "./actions";
import { CampaignLinkCreateForm, CampaignLinkEditForm, type ProductOption } from "./forms";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Links de story",
};

async function loadData(): Promise<{ links: CampaignLink[]; products: ProductOption[] } | null> {
  try {
    const db = getDb();
    const [links, products] = await Promise.all([listCampaignLinks(db), listProducts(db, { status: "active" })]);
    return {
      links,
      products: products
        .map((product) => ({ id: product.id, name: product.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    };
  } catch {
    return null;
  }
}

export default async function CampaignLinksPage() {
  await requireOwner("whatsapp");
  const data = await loadData();
  const siteUrl = siteBaseUrl();

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Links de story" subtitle="Links curtos para o sticker do Instagram que levam direto à Lia." />
        <EmptyState
          title="Não foi possível carregar os links"
          hint="O banco de dados está indisponível no momento. Tente recarregar a página."
        />
      </div>
    );
  }

  const { links, products } = data;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Links de story"
        subtitle="Cole o link no sticker do story: quem toca cai no WhatsApp da Lia já falando da peça, e você vê quantas chegaram e quantas compraram."
        actions={
          <Link
            href="/admin/whatsapp"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Voltar à vendedora
          </Link>
        }
      />

      <Card title="Novo link">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Um link por story ou campanha. O nome vira a URL e não muda depois; o rótulo e a peça você pode ajustar.
          </p>
          <CampaignLinkCreateForm siteUrl={siteUrl} products={products} />
        </div>
      </Card>

      <Card title="Seus links">
        {links.length === 0 ? (
          <EmptyState title="Nenhum link ainda" hint="Crie o primeiro acima e cole a URL no sticker do story." />
        ) : (
          <div className="flex flex-col gap-5">
            <Table headers={["Link", "Peça", "Toques", "Conversas", "Pedidos", "Status", "Ações"]}>
              {links.map((link) => (
                <Tr key={link.id} className={link.isActive ? undefined : "opacity-60"}>
                  <Td>
                    <span className="font-mono font-medium">/ig/{link.slug}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{link.label}</span>
                  </Td>
                  <Td>
                    {link.productSlug ? (
                      <Link href={`/produto/${link.productSlug}`} className="hover:underline" target="_blank" rel="noopener noreferrer">
                        {link.productName}
                      </Link>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </Td>
                  <Td className="tabular-nums">{link.taps}</Td>
                  <Td className="tabular-nums">{link.conversations}</Td>
                  <Td className="tabular-nums">{link.orders}</Td>
                  <Td>{link.isActive ? <Badge tone="success">Ativo</Badge> : <Badge tone="neutral">Desligado</Badge>}</Td>
                  <Td>
                    <form action={toggleCampaignLinkAction}>
                      <input type="hidden" name="id" value={link.id} />
                      <input type="hidden" name="nextActive" value={link.isActive ? "false" : "true"} />
                      <Button type="submit" variant="outline" size="sm">
                        {link.isActive ? "Desligar" : "Ligar"}
                      </Button>
                    </form>
                  </Td>
                </Tr>
              ))}
            </Table>

            <div className="flex flex-col gap-3">
              {links.map((link) => (
                <details key={link.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-800 dark:text-zinc-200">
                    /ig/{link.slug} — copiar e editar
                  </summary>
                  <div className="flex flex-col gap-4 border-t border-zinc-200 p-4 dark:border-zinc-800">
                    <CopyField
                      label="URL para o sticker"
                      value={`${siteUrl}/ig/${link.slug}`}
                      hint={
                        link.isActive
                          ? "Cole no sticker de link do story. Toques contam mesmo sem a Lia ligada."
                          : "Desligado: quem tocar vai para a página da peça, sem contar."
                      }
                    />
                    <CampaignLinkEditForm
                      linkId={link.id}
                      defaults={{ label: link.label, productId: link.productId ?? "" }}
                      products={products}
                    />
                  </div>
                </details>
              ))}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Toques = quem abriu o link. Conversas = quem mandou a primeira mensagem com o código. Pedidos = pedidos fechados nessas conversas (pagos ou não).
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
