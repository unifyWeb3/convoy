import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs as its own workspace step (`pnpm -r lint`) and in CI, so the
  // build does not re-run it.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@convoy/db', '@convoy/kh-client'],
  experimental: {
    outputFileTracingRoot: path.resolve(appDir, '../..'),
    outputFileTracingIncludes: {
      '/*': ['../../node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/**/*'],
    },
  },
};

export default nextConfig;
