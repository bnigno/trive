import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

// serveOrigin fixa o sync na URL ESTÁVEL de produção. Sem isso, o registro no
// Inngest pode apontar para a URL de UM deploy específico e a fila continua
// executando código velho após cada publicação (caso real: menu interativo
// não saía porque o handler rodava o deploy anterior). Em dev a variável
// não existe e o host da requisição continua valendo.
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions,
  serveOrigin: process.env.NEXT_PUBLIC_SITE_URL || undefined,
});
