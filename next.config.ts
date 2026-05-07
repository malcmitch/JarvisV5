import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  output: "standalone",
  // Prevent Next.js from bundling native node modules used in API routes
  serverExternalPackages: ["@jitsi/robotjs", "screenshot-desktop", "sharp"],
  // Allow Electron's local renderer (127.0.0.1) to fetch /_next/* dev assets
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
