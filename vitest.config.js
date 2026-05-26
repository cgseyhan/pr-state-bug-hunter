import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use Node environment for all tests (no browser simulation)
    environment: 'node',

    // Enable globals (describe, it, expect) without imports in test files
    globals: true,

    // Test file patterns
    include: ['tests/**/*.test.js'],

    // Coverage configuration (run with: npx vitest run --coverage)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.js'],
      exclude: ['src/index.js', 'src/test-cases/**'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },

    // Allow top-level await in test files (needed for dynamic imports with mocks)
    pool: 'forks',

    // Sequential to avoid module-singleton cross-contamination between test files
    // (languageRegistry is a module-level singleton)
    sequence: {
      shuffle: false,
    },
  },
});
