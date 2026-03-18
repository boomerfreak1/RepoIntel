/** @type {import('next').NextConfig} */
const nextConfig = {
  sassOptions: {
    silenceDeprecations: ["legacy-js-api", "import"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // ChromaDB tries to import @chroma-core/default-embed which is optional
      config.externals = config.externals || [];
      config.externals.push("@chroma-core/default-embed");
    }
    return config;
  },
  // Allow longer API routes for indexing
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "chromadb"],
  },
};

export default nextConfig;
