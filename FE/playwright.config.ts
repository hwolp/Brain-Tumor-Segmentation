import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const beDir = path.resolve(configDir, '../BE');
const pythonPath = process.env.PYTHONPATH
  ? `${beDir}${path.delimiter}${process.env.PYTHONPATH}`
  : beDir;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5177',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command:
        '..\\BE\\.venv\\Scripts\\python.exe -m scripts.run_p7_e2e_stack --port 8017 --web-origin http://127.0.0.1:5177 --state-file test-results/e2e-stack-state.json',
      env: {
        PYTHONPATH: pythonPath,
      },
      url: 'http://127.0.0.1:8017/api/v1/health/ready',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5177 --strictPort',
      url: 'http://127.0.0.1:5177',
      env: {
        VITE_API_PROXY_TARGET: 'http://127.0.0.1:8017',
        VITE_USE_FIXTURES: 'false',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
