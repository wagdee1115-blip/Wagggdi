import { describe, expect, it } from 'vitest';
import { db } from '../lib/db';

const dbIt = process.env.DATABASE_URL ? it : it.skip;

describe('PostgreSQL integration gate', () => {
  dbIt('connects to PostgreSQL and confirms the migrated baseline tables', async () => {
    const rows = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('User', 'Vehicle', 'VehicleSale')
      ORDER BY table_name
    `;
    expect(rows.map(({ table_name }) => table_name)).toEqual(['User', 'Vehicle', 'VehicleSale']);
  });
});

describe('External-provider E2E', () => {
  it.skip('is deferred until dedicated sandbox providers and end-to-end assertions are available', () => {});
});
