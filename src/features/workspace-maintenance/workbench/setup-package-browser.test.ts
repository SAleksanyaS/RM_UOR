import { expect, it } from 'vitest';
import { createLocalRuntime, codeRoot } from '../../../../tests/workbench/helpers/runtime';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
it.skipIf(!process.env.UOR_TEST_BROWSER_EXECUTABLE)('actual updates UI exports, previews, imports and repeats a common setup at desktop and narrow widths', async () => {
    const f = await createLocalRuntime({ updates: { async check() { return { channel: 'code', expectedCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), available: true, launcherAvailable: false }; } } });
    let host: Awaited<ReturnType<typeof createServer>> | undefined, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        host = await createServer({ configFile: path.join(codeRoot, 'vite.config.ts'), root: codeRoot, cacheDir: path.join(f.root, '.runtime/vite-cache'), server: { host: '127.0.0.1', port: f.ui, strictPort: true, proxy: { '/api': f.origin } } });
        await host.listen();
        browser = await chromium.launch({ executablePath: process.env.UOR_TEST_BROWSER_EXECUTABLE, headless: true, chromiumSandbox: process.env.UOR_SYNTHETIC_CI !== '1' });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
        page.setDefaultTimeout(15000);
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${f.ui}/updates`);
        await page.getByRole('heading', { name: 'Общий пакет рабочего места', exact: true }).waitFor();
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Создать и скачать пакет', exact: true }).click()]);
        const filename = await download.path();
        expect(filename).toBeTruthy();
        await page.getByLabel('Открыть общий пакет JSON').setInputFiles(filename!);
        await page.getByRole('button', { name: 'Проверить и сравнить', exact: true }).click();
        await page.getByRole('heading', { name: 'Изменения до применения' }).waitFor();
        await page.getByRole('button', { name: 'Применить с защитной копией настроек' }).click();
        await page.getByText('Установлено пресетов: 6. Защитных версий: 1.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Проверить и сравнить', exact: true }).click();
        await page.getByRole('button', { name: 'Применить с защитной копией настроек' }).click();
        await page.getByText('Установлено пресетов: 6. Защитных версий: 1.', { exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Применить проверенную версию' }).isDisabled()).toBe(true);
        await page.getByRole('button', { name: 'Проверить общие данные', exact: true }).click();
        await page.getByRole('heading', { name: 'Обновление общих данных' }).waitFor();
        await page.getByRole('button', { name: 'Закрыть обслуживание' }).click();
        if (process.env.UOR_UI_ARTIFACT_DIR) {
            await mkdir(process.env.UOR_UI_ARTIFACT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.UOR_UI_ARTIFACT_DIR, 'setup-updates-desktop.png'), fullPage: true });
        }
        await page.setViewportSize({ width: 390, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (process.env.UOR_UI_ARTIFACT_DIR)
            await page.screenshot({ path: path.join(process.env.UOR_UI_ARTIFACT_DIR, 'setup-updates-mobile.png'), fullPage: true });
        expect(errors).toEqual([]);
    }
    finally {
        await browser?.close();
        await host?.close();
        await f.close();
    }
}, 90000);
