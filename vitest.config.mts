import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.mts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-123',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/placeholder',
      BCRYPT_COST: '4',
      RATE_LIMIT_ENABLED: 'false',
      JOBS_ENABLED: 'false',
      PUBLIC_RATE_LIMIT_PER_MIN: '5',
      RATING_DEBOUNCE_MS: '60000',
      CORS_ORIGINS: 'http://localhost:5173',
    },
  },
});
