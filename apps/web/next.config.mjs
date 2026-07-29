/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs as its own workspace step (`pnpm -r lint`) and in CI, so the
  // build does not re-run it.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ['@convoy/db', '@convoy/kh-client'],
};

export default nextConfig;
