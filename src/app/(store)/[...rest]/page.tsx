// Pega-tudo da vitrine: qualquer URL que nenhuma rota atenda cai aqui e vira
// o 404 da maison (not-found.tsx deste grupo), dentro do layout da loja.
// Um not-found.tsx dentro de um route group só atende notFound() lançado no
// grupo; sem esta rota, /qualquer-coisa cairia no 404 cru da raiz. Segmentos
// estáticos (admin, api, produtos…) têm prioridade sobre o pega-tudo.
import { notFound } from "next/navigation";

export default function CatchAllPage() {
  // Antes de qualquer await, para a resposta sair com status 404.
  notFound();
}
