import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output (Phase 11): traces the minimal set of node_modules
  // this app actually needs and copies them into .next/standalone, so the
  // production Docker image doesn't have to ship the full workspace
  // node_modules tree.
  output: 'standalone',
};

export default nextConfig;
