import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The first information_schema query can be slower on a cold Postgres
    // service (especially on a fresh CI runner). Keep the schema evidence test
    // honest while avoiding a false red from Vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite asserts against one shared database; parallel files would race
    // on the fixture rows they create and delete.
    fileParallelism: false,
  },
});
