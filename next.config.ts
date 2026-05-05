import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Prevent Next.js from bundling native node modules used in API routes
  serverExternalPackages: ["@jitsi/robotjs", "screenshot-desktop", "sharp"],
};

export default nextConfig;
