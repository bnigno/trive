// Feriados nacionais de data fixa (PURO). Os Correios não entregam neles,
// então o prazo em "dias úteis" pula sábado, domingo e estes dias. Feriados
// móveis (Carnaval, Sexta-feira Santa, Corpus Christi) ficam de fora de
// propósito: a promessa fica levemente otimista nessas semanas, o que é
// melhor do que uma tabela errada — e a dona sempre vê o prazo real no painel.
const FIXED_HOLIDAYS_MM_DD = [
  "01-01", // Confraternização Universal
  "04-21", // Tiradentes
  "05-01", // Dia do Trabalho
  "09-07", // Independência
  "10-12", // Nossa Senhora Aparecida
  "11-02", // Finados
  "11-15", // Proclamação da República
  "11-20", // Consciência Negra (nacional desde 2024)
  "12-25", // Natal
] as const;

/** 'YYYY-MM-DD' é feriado nacional de data fixa? */
export function isNationalHoliday(dayKey: string): boolean {
  return (FIXED_HOLIDAYS_MM_DD as readonly string[]).includes(dayKey.slice(5));
}
