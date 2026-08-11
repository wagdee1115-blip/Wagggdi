import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';

describe('E2E verification gates', () => {
  it('requires real PostgreSQL instead of silently skipping', async () => {
    if (!process.env.DATABASE_URL) throw new Error('BLOCKED:POSTGRESQL_REQUIRED');
    await db.$queryRaw`SELECT 1`;
    expect(true).toBe(true);
  });

  it('requires external providers for real E2E', () => {
    if (!process.env.SMS_PROVIDER_URL || !process.env.PAYMENT_PROVIDER_URL || !process.env.TRAFFIC_PROVIDER_URL || !process.env.STORAGE_PROVIDER_URL) {
      throw new Error('BLOCKED:EXTERNAL_PROVIDERS_REQUIRED');
    }
    expect(true).toBe(true);
  });
});
