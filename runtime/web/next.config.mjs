/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API runs on a sibling port; Nginx handles public routing so we
  // do not need Next.js rewrites in front of it.
  reactStrictMode: true,
  poweredByHeader: false,
  // Security headers (additional to the ones Nginx already sends).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
