import type { NextConfig } from "next";

// Playground surfaces carry secrets (admin) or capability URLs (/w/<token>):
// no framing, no caching, no indexing, and — critically for /w — no Referer,
// so the signed link never leaks to third-party hosts like the Yuno SDK CDN.
const playgroundHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "no-store" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
];

const nextConfig: NextConfig = {
  turbopack: {
    // Pin the workspace root (a stray lockfile exists in the home directory).
    root: __dirname,
  },
  async headers() {
    return [
      { source: "/admin", headers: playgroundHeaders },
      { source: "/w/:path*", headers: playgroundHeaders },
      { source: "/api/admin/:path*", headers: playgroundHeaders },
    ];
  },
};

export default nextConfig;
