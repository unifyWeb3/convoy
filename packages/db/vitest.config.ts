import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // The suite asserts against one shared database; parallel files would race
    // on the fixture rows they create and delete.
    fileParallelism: false,
  },
});
