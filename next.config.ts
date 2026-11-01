import type { NextConfig } from "next";

// Tidemark is a fully authenticated, per-workspace app: every route reads the
// Supabase session cookie. Cache Components / partial prefetching add little
// here, so we use the classic dynamic rendering model.
const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
