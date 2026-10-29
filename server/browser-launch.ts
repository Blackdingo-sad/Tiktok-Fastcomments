import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserPageLike, BrowserSessionLike } from './browser-send';

export interface ChromeSessionOptions {
    /** Show the window: false only once a logged-in profile is known to work. */
    headless: boolean;
    log?: (message: string) => void;
}

/**
 * A reused Chrome window driven by Playwright. The TikTok session arrives from
 * the backend's in-RAM store and is written as cookies, so the operator does not
 * log in twice: the desktop app's login window already produced those values.
 */
export function createChromeSession(options: ChromeSessionOptions): BrowserSessionLike {

    const log = options.log ?? (() => undefined);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    const ensureBrowser = async (): Promise<Browser> => {
        // The operator can close the window between sends; relaunch instead of
        // failing every later comment against a dead handle.
        if (browser !== null && !browser.isConnected()) {
            log('[browser] cửa sổ Chrome đã đóng, mở lại');
            browser = null;
            context = null;
            page = null;
        }
        if (browser !== null) return browser;
        log('[browser] mở Chrome để gửi bình luận');
        browser = await chromium.launch({
            channel: 'chrome',
            headless: options.headless,
            // TikTok checks this flag on some builds; leaving it off keeps the
            // page behaving like the operator's own browser.
            args: ['--disable-blink-features=AutomationControlled']
        });
        return browser;
    };

    return {
        async prepare(session): Promise<BrowserPageLike> {
            const instance = await ensureBrowser();

            if (context === null) {
                context = await instance.newContext({
                    viewport: { width: 1280, height: 800 },
                    locale: 'vi-VN'
                });
            }

            await context.addCookies([
                {
                    name: 'sessionid',
                    value: session.sessionId,
                    domain: '.tiktok.com',
                    path: '/',
                    httpOnly: true,
                    secure: true,
                    sameSite: 'None'
                },
                {
                    name: 'tt-target-idc',
                    value: session.ttTargetIdc,
                    domain: '.tiktok.com',
                    path: '/',
                    httpOnly: false,
                    secure: true,
                    sameSite: 'None'
                }
            ]);

            if (page === null || page.isClosed()) {
                page = await context.newPage();
            }

            // Playwright's Page is wider than the slice the sender needs; the cast
            // keeps the send logic free of Playwright types.
            return page as unknown as BrowserPageLike;
        },

        async close(): Promise<void> {
            await browser?.close();
            browser = null;
            context = null;
            page = null;
        }
    };
}
