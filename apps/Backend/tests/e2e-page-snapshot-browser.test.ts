import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  collectPageSnapshot,
  defaultBrowsersPath,
  isSettled,
} from '../src/modules/e2e/adapters/playwright-runner.js';

const browsersPath = process.env['PLAYWRIGHT_BROWSERS_PATH'] || defaultBrowsersPath();
const browserInstalled =
  fs.existsSync(browsersPath) &&
  fs.readdirSync(browsersPath).some((entry) => entry.startsWith('chromium'));

// A single-page app that keeps one heading in its frame on every screen.
const screen = (extra: string) => `<!doctype html><html><head><title>Blue - Planejamento</title></head><body>
<header><h2>Configuração</h2></header>
<nav><button>Painel</button></nav>
<main><h1>Planejamento</h1>
<div role="tablist"><button role="tab" aria-selected="false">Mês</button><button role="tab" aria-selected="true">Semana</button></div>
${extra}
</main></body></html>`;

describe.skipIf(!browserInstalled)('reading a screen in a real browser', () => {
  it('names the screen by its own heading, not by the one in the frame', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(screen(''));
      const snapshot = await page.evaluate(collectPageSnapshot);
      expect(snapshot.headings.slice(0, 2)).toEqual(['Planejamento', 'Configuração']);
      expect(snapshot.tab).toBe('Semana');
      expect(snapshot.dialog).toBeUndefined();
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('reads the dialog open over the screen and tells when it is still loading', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        screen(
          '<div role="dialog"><h3>Legenda</h3><button>Salvar</button></div><div class="skeleton" style="width:50px;height:20px"></div>',
        ),
      );
      const snapshot = await page.evaluate(collectPageSnapshot);
      expect(snapshot.dialog).toBe('Legenda');
      expect(snapshot.headings[0]).toBe('Planejamento');
      expect(await page.evaluate(isSettled)).toBe(false);
      await page.evaluate(() => document.querySelector('.skeleton')?.remove());
      expect(await page.evaluate(isSettled)).toBe(true);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
