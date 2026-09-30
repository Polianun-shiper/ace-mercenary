import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Allow the Z.ai preview pane (preview-*.space-z.ai) to load Next.js
  // dev resources cross-origin. Without this, Next.js 16 refuses to
  // serve /_next/* to the preview iframe and the page stays blank.
  allowedDevOrigins: [
    "preview-*.space-z.ai",
    "*.space-z.ai",
    "localhost",
    "127.0.0.1",
    "*.preview-z.ai",
  ],
};

export default nextConfig;
