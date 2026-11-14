import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 240_000,
  use: { baseURL: 'http://localhost:5174', viewport: { width: 1920, height: 1080 } },
  // own port and never reuse: a dev server from another checkout must not answer for this one
  webServer: { command: 'npx vite --port 5174 --strictPort', url: 'http://localhost:5174', reuseExistingServer: false },
  reporter: [['list']],
});
