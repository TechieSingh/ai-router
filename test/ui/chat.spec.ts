import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
test('chat supports threads, streaming, model controls, and safe text rendering', async ({ page }) => {
  let html = await fs.readFile('media/chat.html', 'utf8');
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace(/<link[^>]*>/, '').replace(/<script[^>]*>[\s\S]*?<\/script>/, '');
  await page.setContent(html); await page.addStyleTag({ content: await fs.readFile('media/chat.css', 'utf8') });
  await page.evaluate(() => { (window as any).sent = []; (window as any).acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: (m: any) => (window as any).sent.push(m) }); });
  await page.addScriptTag({ content: await fs.readFile('media/chat.js', 'utf8') });
  await page.evaluate(() => window.postMessage({ type: 'state', thread: 'a', project: 'my-project', threads: [{ id: 'a', title: 'First chat' }, { id: 'b', title: 'Second chat' }], events: [], busy: false, spent: 0, budget: 5, configured: { jev: true, cloud: true } }, '*'));
  await expect(page.getByRole('heading', { name: 'What are we building?' })).toBeVisible();
  await page.getByRole('button', { name: 'Explore this project' }).click();
  await page.getByLabel('Model routing mode').selectOption('local'); await page.getByRole('button', { name: 'Send', exact: false }).click();
  await expect(page.locator('#send')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).sent.at(-1))).toEqual({ type: 'send', mode: 'local', text: 'Explore this project and explain its structure.' });
  await page.evaluate(() => {
    window.postMessage({ type: 'event', thread: 'a', event: { kind: 'message', payload: { role: 'user', content: 'Explore this project' } } }, '*');
    window.postMessage({ type: 'delta', thread: 'a', text: '<img src=x onerror="window.hacked=true">\n```ts\nconst x = 1;\n```' }, '*');
  });
  await expect(page.locator('.message.assistant')).toContainText('<img'); expect(await page.evaluate(() => (window as any).hacked)).toBeUndefined();
  await expect(page.locator('.message.assistant pre')).toContainText('const x = 1');
  await page.screenshot({ path: '.runtime/chat-preview.png', fullPage: true });
  await page.getByLabel('Conversation', { exact: true }).selectOption('b');
  expect(await page.evaluate(() => (window as any).sent.at(-1))).toEqual({ type: 'select', id: 'b' });
});
