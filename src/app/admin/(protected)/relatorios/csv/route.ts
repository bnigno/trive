import { getDb } from "@/db/client";
import { requireOwner } from "@/services/auth";
import { monthlyAccountantReport, reportToCsv } from "@/services/reports";

export const dynamic = "force-dynamic";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Mês corrente no fuso de São Paulo, formato YYYY-MM. */
function currentMonthSP(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}

/**
 * Baixa o CSV mensal para o contador. `?m=YYYY-MM` (default: mês atual SP).
 * requireOwner() redireciona (307) para o login ou para /admin/sem-acesso —
 * num download isso vira uma página aberta no lugar do arquivo, que é o
 * comportamento desejado: o funcionário vê o aviso em vez de baixar o
 * faturamento do mês.
 */
export async function GET(request: Request): Promise<Response> {
  await requireOwner("relatorios");

  const requested = new URL(request.url).searchParams.get("m");
  if (requested !== null && !MONTH_PATTERN.test(requested)) {
    return new Response("Mês inválido: use o formato YYYY-MM.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const month = requested ?? currentMonthSP();
  const [year, monthNumber] = month.split("-").map(Number);

  const rows = await monthlyAccountantReport(getDb(), {
    year,
    month: monthNumber,
  });

  // BOM UTF-8: sem ele o Excel (Windows) lê acentos errado.
  const csv = "\uFEFF" + reportToCsv(rows);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vendas-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
