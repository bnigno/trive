// O bloco "Vídeo da peça" renderizado com react-dom/server: os bloqueios
// (desligado, sem chave, sem foto escolhida), o botão com o custo e a
// confirmação, o vídeo com capa e "Baixar" (nome do arquivo), a legenda com o
// aviso de IA, e a atualização sozinha só enquanto há vídeo sendo feito.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FakeFileStorage } from "@/adapters/storage/fake";
import { StudioVideoBlock } from "@/app/admin/(protected)/produtos/[id]/studio-video-block";
import type { StudioVideoPanel } from "@/services/studio-video";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const PRODUCT_ID = "00000000-0000-4000-8000-0000000000aa";
const CANDIDATE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-25T13:00:00Z");

function video(over: Partial<StudioVideoPanel["videos"][number]> = {}): StudioVideoPanel["videos"][number] {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    productId: PRODUCT_ID,
    candidateId: CANDIDATE_ID,
    sourceStoragePath: "studio/products/p/c.jpg",
    color: "Vinho",
    durationSeconds: 5,
    resolution: "1080p",
    prompt: "p",
    status: "done",
    vendorJobId: "job-1",
    vendor: "fashn",
    vendorModel: "image-to-video",
    polls: 1,
    submittedAt: NOW,
    giveUpAt: NOW,
    storagePath: "studio/videos/p/v.mp4",
    bytes: 16_000_000,
    credits: 6,
    usdCents: 45,
    elapsedMs: 266_000,
    errorDetail: null,
    requestedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: NOW,
    canRefetch: false,
    ...over,
  };
}

function panel(over: Partial<StudioVideoPanel> = {}): StudioVideoPanel {
  return {
    settings: { enabled: true, dailyLimit: 2 },
    sources: [{ candidateId: CANDIDATE_ID, productImageId: "33333333-3333-4333-8333-333333333333", storagePath: "studio/products/p/c.jpg", color: "Vinho" }],
    videos: [],
    inFlight: false,
    estimate: { credits: 6, usdCents: 45, brlCents: 248 },
    usedToday: 0,
    ...over,
  };
}

const CAPTION = { caption: "Vestido Amora.\nImagem ilustrativa (feita com IA a partir da peça real).\n\n#Belém\n\nhttps://x/produto/amora", filename: "vestido-amora-video.mp4" };

function render(p: StudioVideoPanel, input: { configured?: boolean; caption?: typeof CAPTION | { caption: null; filename: string } } = {}) {
  return renderToStaticMarkup(
    <StudioVideoBlock productId={PRODUCT_ID} panel={p} caption={input.caption ?? CAPTION} configured={input.configured ?? true} storage={new FakeFileStorage()} />,
  );
}

describe("StudioVideoBlock", () => {
  it("bloqueios em ordem: desligado, sem chave, sem foto no corpo escolhida", () => {
    expect(render(panel({ settings: { enabled: false, dailyLimit: 2 } }))).toContain("O vídeo da peça está desligado.");
    expect(render(panel(), { configured: false })).toContain("Falta a chave da FASHN na hospedagem.");
    const semFoto = render(panel({ sources: [] }));
    expect(semFoto).toContain("Escolha uma foto no corpo primeiro.");
    expect(semFoto).toContain('href="#foto-no-corpo"');
    expect(semFoto).not.toContain("Fazer vídeo (");
  });

  it("uma foto escolhida: o botão com o custo, o teto do dia e os campos do form", () => {
    const html = render(panel({ usedToday: 1 }));
    // formatCentsBRL separa "R$" do valor com espaço inseparável.
    expect(html).toMatch(/Fazer vídeo \(≈ R\$\s2,48\)/);
    expect(html).toContain("Hoje: 1 de 2 vídeo(s) do teto do dia");
    expect(html).toContain(`name="candidateId" value="${CANDIDATE_ID}"`);
    expect(html).toContain(`name="productId" value="${PRODUCT_ID}"`);
    expect(html).toContain('src="memory://studio/products/p/c.jpg"');
    // Nada a atualizar sozinho sem vídeo em andamento.
    expect(html).not.toContain("A tela atualiza sozinha");
  });

  it("vídeo pronto: player com capa, 'Baixar' com o nome do arquivo, a legenda com o aviso de IA e o lembrete do rótulo", () => {
    const html = render(panel({ videos: [video()] }));
    expect(html).toMatch(/<video[^>]*poster="memory:\/\/studio\/products\/p\/c\.jpg"[^>]*src="memory:\/\/studio\/videos\/p\/v\.mp4"/);
    expect(html).toContain('href="memory://studio/videos/p/v.mp4?download=vestido-amora-video.mp4"');
    expect(html).toContain("Baixar vídeo");
    expect(html).toContain("Imagem ilustrativa (feita com IA a partir da peça real).");
    expect(html).toContain("Copiar legenda");
    expect(html).toContain("rótulo de IA");
    expect(html).toContain("Descartar");
    expect(html).not.toContain("Buscar de novo");
  });

  it("sem legenda de post (peça sem preço/fora da vitrine): o aviso de IA vai sozinho", () => {
    const html = render(panel({ videos: [video()] }), { caption: { caption: null, filename: "x-video.mp4" } });
    expect(html).toContain("Imagem ilustrativa (feita com IA a partir da peça real).");
    expect(html).toContain("A legenda completa sai quando a peça tiver preço");
  });

  it("vídeo sendo feito: rótulo no lugar do player, botão da foto travado e a tela se atualiza sozinha", () => {
    const html = render(panel({ videos: [video({ status: "processing", storagePath: null })], inFlight: true }));
    expect(html).toContain("Fazendo o vídeo… (uns 5 min)");
    expect(html).not.toContain("<video");
    expect(html).toContain("A tela atualiza sozinha enquanto o vídeo é feito.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Fazendo o vídeo…<\/button>/);
  });

  it("falhou com id: 'Buscar de novo (sem pagar)' e o motivo em português", () => {
    const html = render(panel({ videos: [video({ status: "failed", storagePath: null, errorDetail: "demorou_demais: x", canRefetch: true })] }));
    expect(html).toContain("Buscar de novo (sem pagar)");
    expect(html).toContain("a FASHN não entregou em 30 min");
  });
});
