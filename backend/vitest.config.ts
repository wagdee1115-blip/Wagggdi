import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks', // Isolate test files so concurrent DB tests do not interfere
  },
});
