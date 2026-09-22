import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test/ui', use: { browserName: 'chromium', channel: 'msedge', headless: true, viewport: { width: 390, height: 820 } }, workers: 1, reporter: 'list' });
