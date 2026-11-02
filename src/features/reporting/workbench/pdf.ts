import { chromium, type BrowserType } from 'playwright';
import { WorkbenchHttpError } from '../../../server/workbench/protocol';
/** Fresh isolated browser, no banking profile, no network, sandbox always enabled in production. */
export function createReportPdfRenderer({ executablePath, launcher = chromium }: {
    executablePath: () => string | null | Promise<string | null>;
    launcher?: Pick<BrowserType, 'launch'>;
}) {
    return async (html: string): Promise<Buffer> => {
        const executable = await executablePath();
        if (!executable)
            throw new WorkbenchHttpError(503, 'REPORT_PDF_BROWSER_REQUIRED', 'Укажите установленный СберБраузер в настройках рабочего места для экспорта PDF.');
        const browser = await launcher.launch({ executablePath: executable, headless: true, chromiumSandbox: true });
        try {
            const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', ignoreHTTPSErrors: false });
            await context.route('**/*', route => route.abort('blockedbyclient'));
            const page = await context.newPage();
            await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
            return await page.pdf({ format: 'A4', landscape: true, printBackground: true, preferCSSPageSize: true });
        }
        finally {
            await browser.close();
        }
    };
}
