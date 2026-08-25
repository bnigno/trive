import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // No Next 16.3 a chave serverActions.bodySizeLimit ainda vive sob
    // `experimental` (conferido em node_modules/next/dist/server/config-schema.js,
    // experimentalSchema.serverActions). Elevamos o padrão de 1mb para 8mb para
    // permitir upload de imagens de produto via server action (FormData/File).
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
