// Tradução de erros para as server actions das telas de preços.
// Só para uso no servidor (importa o serviço de precificação).
import { PricingError } from "@/core/pricing";
import { ServiceError } from "@/services/pricing";

/**
 * Erros de negócio chegam com mensagem pt-BR (ServiceError/PricingError) e os
 * de entrada monetária/percentual como RangeError — mostramos a mensagem.
 * Qualquer outro erro vira a mensagem genérica.
 */
export function actionErrorMessage(error: unknown): string {
  if (
    error instanceof ServiceError ||
    error instanceof PricingError ||
    error instanceof RangeError
  ) {
    return error.message;
  }
  return "Algo deu errado, tente novamente.";
}
