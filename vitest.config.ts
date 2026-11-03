import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each worker holds terminals and bundles; on machines with many cores an unbounded pool ran out of memory.
    maxWorkers: 4,
  },
});
