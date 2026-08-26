import type { ReactNode } from "react";
import { isOwner } from "@/services/auth";

/**
 * Esconde um bloco de tela de quem não é proprietário. O guard viaja junto
 * com o JSX, então não dá para copiar o bloco para outra página e perder a
 * proteção no caminho.
 *
 * Cuidado: isto some com o bloco, não com o dado. Se o valor sensível (custo,
 * margem, taxa) vem de uma consulta, a consulta também precisa ficar dentro
 * de um componente próprio que se auto-protege — senão o dado continua
 * viajando no HTML do servidor.
 */
export async function OwnerOnly({ children }: { children: ReactNode }) {
  if (!(await isOwner())) return null;
  return <>{children}</>;
}
