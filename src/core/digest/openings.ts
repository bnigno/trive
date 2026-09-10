// Frase de abertura do "Bom dia da maison": uma por dia da semana, com a
// variante para dia sem venda. Determinística (dia → frase) e sem emoji ou
// símbolo: o texto entra na imagem, que não pode buscar fonte pela rede.

const WITH_SALES: readonly string[] = [
  "Domingo também vende: veja como foi ontem.",
  "Semana nova. Ontem ficou assim.",
  "Terça-feira: o balanço de ontem, antes do café.",
  "Meio de semana. Ontem rendeu isto.",
  "Quinta-feira: o resumo de ontem está pronto.",
  "Sexta chegou. Ontem foi assim na maison.",
  "Sábado: o que ontem deixou de bom.",
];

const WITHOUT_SALES: readonly string[] = [
  "Domingo sem venda: hoje é dia de mostrar peça nova.",
  "Ontem foi dia de descanso. Hoje é dia de vender.",
  "Terça sem venda ontem. Um bom dia para um lançamento.",
  "Quarta-feira: ontem ficou quieto. Hoje a gente muda isso.",
  "Quinta-feira: sem venda ontem. Bora acordar a vitrine.",
  "Sexta: ontem passou em branco. Fim de semana pede novidade.",
  "Sábado: ontem sem venda. Hoje as clientes têm tempo.",
];

export function openingFor(weekdayIndex: number, hadSales: boolean): string {
  const index = ((weekdayIndex % 7) + 7) % 7;
  return (hadSales ? WITH_SALES : WITHOUT_SALES)[index];
}

export const OPENINGS_WITH_SALES = WITH_SALES;
export const OPENINGS_WITHOUT_SALES = WITHOUT_SALES;
