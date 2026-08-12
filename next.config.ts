import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  output: "standalone",
  serverExternalPackages: ["@jitsi/robotjs", "screenshot-desktop"],
  images: {
    // Every image is a local asset shipped at its final size, so runtime
    // optimization buys nothing — and skipping it keeps sharp's ~16 MB of
    // libvips binaries out of the installer.
    unoptimized: true,
  },
  // Next traces from the project root and sweeps in large files no route
  // actually reads. postbuild.js prunes what slips through; these keep the
  // heaviest offenders out of the trace to begin with.
  outputFileTracingExcludes: {
    "*": [
      "public/**",
      "art-source/**",
      "release/**",
      "social-captures/**",
      "scripts/dist/**",
      ".venv*/**",
      ".pyinstaller/**",
      "intro.mp4",
      "node_modules/typescript/**",
      "node_modules/@types/**",
      "node_modules/electron/**",
      "node_modules/@img/**",
      "node_modules/sharp/**",
    ],
  },
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "192.168.*",
    "10.*",
    "172.*",
  ],
};

export default nextConfig;
