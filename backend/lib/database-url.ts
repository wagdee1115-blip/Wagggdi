const PREVIEW_NEON_HOST = 'ep-broad-firefly-a6yus3j2-pooler.us-west-2.aws.neon.tech';

/**
 * Keep Vercel Preview traffic isolated from the Neon main branch without
 * duplicating database credentials. Neon child branches created from an
 * unprotected parent inherit the same Postgres role credentials, so Preview
 * can safely reuse the configured DATABASE_URL credentials while routing to
 * the dedicated preview branch hostname.
 *
 * Production, CI, and local environments are never rewritten.
 */
export function resolveDatabaseUrl(
  databaseUrl = process.env.DATABASE_URL,
  vercelEnv = process.env.VERCEL_ENV,
): string | undefined {
  if (!databaseUrl) return undefined;
  if (vercelEnv !== 'preview') return databaseUrl;

  const parsed = new URL(databaseUrl);
  if (!parsed.hostname.endsWith('.neon.tech')) {
    throw new Error('PREVIEW_DATABASE_ISOLATION_REQUIRES_NEON_DATABASE_URL');
  }

  parsed.hostname = PREVIEW_NEON_HOST;
  return parsed.toString();
}

export const previewDatabaseHost = PREVIEW_NEON_HOST;
