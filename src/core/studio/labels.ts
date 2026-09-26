// Rótulos do ensaio para o painel e para o WhatsApp da dona — PURO. O que
// cada candidata e cada pedido significam, em português, sem a tela ter de
// conhecer status e julgamento.
import { fidelityJudgmentSchema, fidelitySummary } from "./fidelity";

export type CandidateLike = {
  status: string;
  passed: boolean;
  judgment: unknown;
  errorDetail: string | null;
  storagePath: string | null;
};

export type StudioLabel = { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" };

/** "8/10", "Reprovada: cor, estampa", "Sem julgamento", "Falhou: sem créditos", "Na peça". */
export function candidateLabel(candidate: CandidateLike): StudioLabel {
  if (candidate.status === "chosen") return { label: "Na peça", tone: "success" };
  if (candidate.status === "discarded") return { label: "Descartada", tone: "neutral" };
  if (candidate.status === "failed") return { label: `Falhou: ${failureLabel(candidate.errorDetail)}`, tone: "danger" };
  const judgment = fidelityJudgmentSchema.safeParse(candidate.judgment);
  if (!judgment.success) return { label: "Sem julgamento — confira com o olho", tone: "warning" };
  if (candidate.status === "rejected" || !candidate.passed) return { label: `Reprovada: ${fidelitySummary(judgment.data)}`, tone: "danger" };
  return { label: `Aprovada ${fidelitySummary(judgment.data)}`, tone: "success" };
}

const FAILURE_LABELS: Record<string, string> = {
  no_credits: "sem créditos na FASHN",
  no_key: "chave da FASHN ausente ou inválida",
  rejected: "o gerador recusou esta foto",
  sem_foto_real: "a foto real da cor sumiu",
  sem_foto_base: "a foto-base da modelo foi descartada",
  peca_nao_encontrada: "a peça foi apagada",
  imagem_ilegivel: "o gerador devolveu uma imagem ilegível",
  vendor_sem_imagem: "o gerador não devolveu imagem",
  envio_incerto: "não deu para confirmar o envio — confira o saldo da FASHN daqui a 10 min antes de pedir de novo",
  demorou_demais: "a FASHN não entregou em 30 min — dá para buscar de novo por 3 dias, sem pagar",
  nao_salvou: "o vídeo ficou pronto mas não foi guardado — dá para buscar de novo, sem pagar",
  pedido_sumiu: "a FASHN não reconhece mais o pedido",
  video_desligado: "o vídeo foi desligado antes de sair",
  sem_envio: "não deu para enviar à FASHN depois de 4 tentativas — nada foi cobrado",
};

export function failureLabel(errorDetail: string | null): string {
  if (!errorDetail) return "motivo desconhecido";
  const code = errorDetail.split(":")[0]?.trim() ?? "";
  return FAILURE_LABELS[code] ?? errorDetail;
}

export type RequestLike = { status: string; optionsWanted: number; optionsDone: number; usdCentsSpent: number };

/** "Na fila (1 de 3)", "Pronto", "Falhou". */
export function requestLabel(request: RequestLike): StudioLabel {
  if (request.status === "done") return { label: "Pronto", tone: "success" };
  if (request.status === "failed") return { label: "Falhou", tone: "danger" };
  return { label: `Na fila (${request.optionsDone} de ${request.optionsWanted})`, tone: "info" };
}

export type VideoLike = { status: string; errorDetail: string | null };

/** "Na fila", "Fazendo o vídeo…", "Pronto", "Falhou: …". */
export function videoLabel(video: VideoLike): StudioLabel {
  switch (video.status) {
    case "queued":
      return { label: "Na fila", tone: "info" };
    case "submitting":
      return { label: "Enviando à FASHN…", tone: "info" };
    case "processing":
      return { label: "Fazendo o vídeo… (uns 5 min)", tone: "info" };
    case "done":
      return { label: "Pronto", tone: "success" };
    case "discarded":
      return { label: "Descartado", tone: "neutral" };
    default:
      return { label: `Falhou: ${failureLabel(video.errorDetail)}`, tone: "danger" };
  }
}

/**
 * O gasto do estúdio numa linha: "fotos no corpo (9)" como sempre; com vídeo,
 * "fotos e vídeos no corpo (9 fotos · 1 vídeo)". null = nada gasto.
 */
export function studioSpendLabel(input: { images: number; videos: number }): { what: string; count: string } | null {
  if (input.images <= 0 && input.videos <= 0) return null;
  if (input.videos <= 0) return { what: "fotos no corpo", count: String(input.images) };
  const videos = `${input.videos} ${input.videos === 1 ? "vídeo" : "vídeos"}`;
  if (input.images <= 0) return { what: "vídeos no corpo", count: videos };
  return { what: "fotos e vídeos no corpo", count: `${input.images} ${input.images === 1 ? "foto" : "fotos"} · ${videos}` };
}
