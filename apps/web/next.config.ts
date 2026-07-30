import type { NextConfig } from "next";

const controlPlaneUrl = (
  process.env.SOCRATES_API_URL ?? "http://127.0.0.1:3001"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@socrates/contracts", "@socrates/design-system"],
  async rewrites() {
    return [
      {
        source: "/control-plane/:path*",
        destination: `${controlPlaneUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
