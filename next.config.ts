import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root (a stray lockfile exists in the home directory).
    root: __dirname,
  },
};

export default nextConfig;
