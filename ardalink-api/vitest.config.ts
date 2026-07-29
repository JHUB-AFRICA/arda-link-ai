import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    // Bumped from the vitest 5 s default because several route + client
    // modules (supabase, satellite, engine) pay a transitive
    // @workspace/db load at first import. Individual test bodies still
    // run in milliseconds; the timeout only matters during collection
    // when the full suite is scheduled concurrently.
    testTimeout: 15_000,
  },
});