/** @type {import('next').NextConfig} */
const isProduction = process.env.NODE_ENV === 'production';
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Content-Security-Policy', value: `default-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` },
];
module.exports = {
  reactStrictMode: true,
  async headers() { return [{ source: '/(.*)', headers: securityHeaders }]; },
};
