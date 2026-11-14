import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 240_000,
  use: { baseURL: 'http://localhost:5173', viewport: { width: 1920, height: 1080 } },
  webServer: { command: 'npx vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true },
  reporter: [['list']],
});
