import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The real `vscode` module only exists inside VS Code; tests use a stand-in (see the file for its limits).
    alias: { vscode: fileURLToPath(new URL('./test/mocks/vscode.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Each worker holds terminals and bundles; on machines with many cores an unbounded pool ran out of memory.
    maxWorkers: 4,
  },
});
