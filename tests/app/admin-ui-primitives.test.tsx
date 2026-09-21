// Primitivas visuais do painel (gráfico, tendência, avatar, medidor): só
// apresentação, renderizadas com react-dom/server. O que se afirma aqui é a
// geometria e a acessibilidade, não a cor.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Avatar, initialsOf } from "@/components/ui/avatar";
import { BarChart, niceMax } from "@/components/ui/bar-chart";
import { Meter } from "@/components/ui/meter";
import { Sparkline } from "@/components/ui/sparkline";
import { compareDays, TrendBadge } from "@/components/ui/trend";

describe("Sparkline", () => {
  it("desenha uma linha com um ponto final (anel + miolo) e fica fora da árvore acessível", () => {
    const html = renderToStaticMarkup(<Sparkline values={[1, 3, 2, 5]} />);
    expect(html.match(/<path /g)).toHaveLength(1);
    expect(html.match(/<circle /g)).toHaveLength(2);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke-width="2"');
  });

  it("tudo zero vira linha reta na base", () => {
    const html = renderToStaticMarkup(<Sparkline values={[0, 0, 0]} width={96} height={28} />);
    // Base = altura − padding (4): todos os pontos em y=24.
    expect(html).toContain('d="M4.0,24.0 L48.0,24.0 L92.0,24.0"');
  });

  it("sem valores não renderiza nada", () => {
    expect(renderToStaticMarkup(<Sparkline values={[]} />)).toBe("");
  });
});

describe("BarChart", () => {
  const points = Array.from({ length: 14 }, (_, index) => ({
    label: `${String(index + 1).padStart(2, "0")}/09`,
    value: index === 13 ? 1000 : index === 6 ? 500 : index === 0 ? 0 : 100,
    detail: `dia ${index + 1}`,
  }));

  it("uma coluna por ponto, com role=img, rótulo acessível e tabela só para leitores de tela", () => {
    const html = renderToStaticMarkup(
      <BarChart points={points} formatTick={(value) => String(value)} ariaLabel="Vendas por dia" />,
    );
    expect(html).toContain('role="img" aria-label="Vendas por dia"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(14);
    // Valor zero não vira barra.
    expect(html.match(/data-bar="true"/g)).toHaveLength(13);
    expect(html).toContain('<table class="sr-only">');
    expect(html.match(/<tr>/g)).toHaveLength(14);
    expect(html.match(/role="tooltip"/g)).toHaveLength(14);
  });

  it("altura proporcional ao teto do eixo: 100 % no máximo, 50 % na metade, mínimo 4 % no valor pequeno", () => {
    const html = renderToStaticMarkup(
      <BarChart points={points} formatTick={(value) => String(value)} ariaLabel="x" />,
    );
    expect(html).toContain("height:100.0%");
    expect(html).toContain("height:50.0%");
    expect(html).toContain("height:10.0%");
    expect(html.match(/data-direct-label="true"/g)).toHaveLength(1);
    expect(html).toContain(">1000</span>");
  });

  it("mínimo de 4 % para valor positivo minúsculo", () => {
    const html = renderToStaticMarkup(
      <BarChart
        points={[
          { label: "a", value: 1, detail: "a" },
          { label: "b", value: 1000, detail: "b" },
        ]}
        formatTick={(value) => String(value)}
        ariaLabel="x"
      />,
    );
    expect(html).toContain("height:4.0%");
  });

  it("niceMax arredonda o teto para um número limpo", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(61)).toBe(100);
    expect(niceMax(1234)).toBe(2000);
    expect(niceMax(42000)).toBe(50000);
    expect(niceMax(250)).toBe(250);
  });
});

describe("compareDays / TrendBadge", () => {
  it("percentual sobre ontem, com sinal", () => {
    expect(compareDays(5, 4)).toEqual({ direction: "up", label: "+25% vs. ontem" });
    expect(compareDays(3, 4)).toEqual({ direction: "down", label: "−25% vs. ontem" });
    expect(compareDays(4, 4)).toEqual({ direction: "flat", label: "igual a ontem" });
  });

  it("base zero: diferença absoluta quando há movimento hoje, travessão quando não há", () => {
    expect(compareDays(3, 0)).toEqual({ direction: "up", label: "+3 vs. ontem" });
    expect(compareDays(0, 0)).toEqual({ direction: "flat", label: "— vs. ontem" });
    expect(compareDays(150000, 0, (cents) => `R$ ${cents / 100}`)).toEqual({
      direction: "up",
      label: "+R$ 1500 vs. ontem",
    });
  });

  it("cor da seta segue direção × se subir é bom", () => {
    expect(renderToStaticMarkup(<TrendBadge today={5} yesterday={4} />)).toContain("text-emerald-600");
    expect(renderToStaticMarkup(<TrendBadge today={3} yesterday={4} />)).toContain("text-red-600");
    expect(
      renderToStaticMarkup(<TrendBadge today={5} yesterday={4} positiveIsGood={false} />),
    ).toContain("text-red-600");
    const flat = renderToStaticMarkup(<TrendBadge today={4} yesterday={4} />);
    expect(flat).not.toContain("text-emerald-600");
    expect(flat).not.toContain("text-red-600");
  });
});

describe("Avatar", () => {
  it("iniciais: primeira e última palavra do nome; sem nome, a inicial do e-mail", () => {
    expect(initialsOf("Ana Souza", "ana@x.com")).toBe("AS");
    expect(initialsOf("Ana Maria de Souza", "ana@x.com")).toBe("AS");
    expect(initialsOf("Ana", "ana@x.com")).toBe("A");
    expect(initialsOf(null, "maria@x.com")).toBe("M");
    expect(initialsOf("  ", "")).toBe("?");
  });

  it("a cor é determinística pelo e-mail e o avatar não fala com leitores de tela", () => {
    const a = renderToStaticMarkup(<Avatar name="Ana" fallback="ana@x.com" />);
    const b = renderToStaticMarkup(<Avatar name="Outra" fallback="ANA@x.com" />);
    expect(a).toContain('aria-hidden="true"');
    const toneOf = (html: string) => html.match(/bg-[a-z]+-\d+/)?.[0];
    expect(toneOf(a)).toBe(toneOf(b));
  });
});

describe("Meter", () => {
  it("é uma progressbar com valor limitado ao máximo", () => {
    const html = renderToStaticMarkup(<Meter value={3} max={4} label="Peças prontas" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="4"');
    expect(html).toContain("width:75.0%");
    const over = renderToStaticMarkup(<Meter value={9} max={4} label="x" />);
    expect(over).toContain('aria-valuenow="4"');
    expect(over).toContain("width:100.0%");
    const empty = renderToStaticMarkup(<Meter value={1} max={0} label="x" />);
    expect(empty).toContain("width:0.0%");
  });
});
