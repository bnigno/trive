import { describe, expect, it } from "vitest";

import { collectionCanonical } from "@/core/seo/canonical";

describe("collectionCanonical", () => {
  it("sem filtros é a coleção; sala é página própria; busca cai na coleção com noindex", () => {
    expect(collectionCanonical({})).toEqual({ canonical: "/produtos", noindex: false });
    expect(collectionCanonical({ categoria: "vestidos" })).toEqual({
      canonical: "/produtos?categoria=vestidos",
      noindex: false,
    });
    expect(collectionCanonical({ categoria: "vestidos", q: "linho" })).toEqual({ canonical: "/produtos", noindex: true });
    expect(collectionCanonical({ categoria: "sala nova & cia" }).canonical).toBe("/produtos?categoria=sala%20nova%20%26%20cia");
    expect(collectionCanonical({ q: "   " })).toEqual({ canonical: "/produtos", noindex: false });
  });

  it("chip de Edição de Belém aponta para /belem/<slug> (a página da edição é a que indexa)", () => {
    expect(collectionCanonical({ edicao: "vestida-para-o-cirio" })).toEqual({ canonical: "/belem/vestida-para-o-cirio", noindex: true });
    expect(collectionCanonical({ edicao: "cirio", categoria: "vestidos" })).toEqual({ canonical: "/belem/cirio", noindex: true });
    expect(collectionCanonical({ edicao: "cirio", q: "linho" })).toEqual({ canonical: "/produtos", noindex: true });
  });
});
