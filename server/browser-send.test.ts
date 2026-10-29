import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CHAT_INPUT_SELECTORS,
    createBrowserCommentSender,
    typeCommentIntoLivePage,
    type BrowserPageLike,
    type BrowserSessionLike
} from './browser-send';

interface FakePageOptions {
    url?: string;
    /** Selectors the fake page pretends to find; defaults to every candidate. */
    available?: string[];
    /** False simulates a chat that keeps the text, i.e. Enter did not send. */
    inputClears?: boolean;
}

/** Records the browser actions so the send sequence can be asserted. */
function createFakePage(options: FakePageOptions = {}): BrowserPageLike & { events: string[] } {
    const events: string[] = [];
    const available = options.available ?? CHAT_INPUT_SELECTORS;
    let currentUrl = options.url ?? '';
    let inInput = '';

    return {
        events,
        url: () => currentUrl,
        async innerText() {
            return inInput;
        },
        async goto(url) {
            events.push(`goto ${url}`);
            currentUrl = url;
        },
        async waitForSelector(selector) {
            if (!available.includes(selector)) throw new Error(`selector not found: ${selector}`);
        },
        async click(selector) {
            events.push(`click ${selector}`);
        },
        keyboard: {
            async insertText(text) {
                events.push(`type ${text}`);
                inInput = text;
            },
            async press(key) {
                events.push(`press ${key}`);
                if (options.inputClears !== false && key === 'Enter') inInput = '';
            }
        }
    };
}

const session = { sessionId: 'session-1', ttTargetIdc: 'useast1a' };

describe('typeCommentIntoLivePage', () => {

    test('navigates to the room, types the comment and presses Enter', async () => {
        const page = createFakePage();

        await typeCommentIntoLivePage(page, { uniqueId: 'someone', content: 'xin chao', timeoutMs: 2_000 });

        assert.deepEqual(page.events, [
            'goto https://www.tiktok.com/@someone/live',
            `click ${CHAT_INPUT_SELECTORS[0]}`,
            'type xin chao',
            'press Enter'
        ]);
    });

    test('reuses the page that is already on the room', async () => {
        const page = createFakePage({ url: 'https://www.tiktok.com/@someone/live' });

        await typeCommentIntoLivePage(page, { uniqueId: 'someone', content: 'hi', timeoutMs: 2_000 });

        assert.equal(page.events.some((event) => event.startsWith('goto')), false);
        assert.deepEqual(page.events.slice(-2), ['type hi', 'press Enter']);
    });

    test('falls back to the next selector when TikTok renamed the input', async () => {
        const page = createFakePage({ available: ['textarea[placeholder]'] });

        await typeCommentIntoLivePage(page, { uniqueId: 'someone', content: 'hi', timeoutMs: 2_000 });

        assert.equal(page.events[1], 'click textarea[placeholder]');
    });

    test('collapses newlines so LIVE chat gets one comment, not half of it', async () => {
        const page = createFakePage({ url: 'https://www.tiktok.com/@someone/live' });

        await typeCommentIntoLivePage(page, { uniqueId: 'someone', content: 'line one\nline two', timeoutMs: 2_000 });

        assert.deepEqual(page.events.slice(-2), ['type line one line two', 'press Enter']);
    });

    test('reports a send TikTok did not take instead of claiming success', async () => {
        const page = createFakePage({
            url: 'https://www.tiktok.com/@someone/live',
            inputClears: false
        });

        await assert.rejects(
            typeCommentIntoLivePage(page, { uniqueId: 'someone', content: 'hi', timeoutMs: 1_500 }),
            (error: unknown) => (error as { code?: string }).code === 'browser_send_unconfirmed'
        );
    });

    test('reports a missing input instead of silently doing nothing', async () => {
        const page = createFakePage({ available: [] });

        await assert.rejects(
            typeCommentIntoLivePage(page, { uniqueId: 'someone', content: 'hi', timeoutMs: 120 }),
            (error: unknown) => (error as { code?: string }).code === 'browser_input_missing'
        );
        // It navigated, then refused to click or type anywhere.
        assert.deepEqual(page.events, ['goto https://www.tiktok.com/@someone/live']);
    });

});

describe('createBrowserCommentSender', () => {

    function createSession(page: BrowserPageLike): BrowserSessionLike {
        return {
            async prepare() {
                return page;
            },
            async close() {}
        };
    }

    test('sends one comment at a time so sends cannot share the input box', async () => {
        const page = createFakePage({ url: 'https://www.tiktok.com/@someone/live' });
        const sender = createBrowserCommentSender({
            createSession: async () => createSession(page),
            timeoutMs: 2_000
        });

        await Promise.all([
            sender.sendComment({ uniqueId: 'someone', content: 'first', session }),
            sender.sendComment({ uniqueId: 'someone', content: 'second', session })
        ]);

        assert.deepEqual(page.events, [
            `click ${CHAT_INPUT_SELECTORS[0]}`,
            'type first',
            'press Enter',
            `click ${CHAT_INPUT_SELECTORS[0]}`,
            'type second',
            'press Enter'
        ]);
    });

    test('keeps working after a failed send', async () => {
        const broken = createFakePage({ available: [] });
        const working = createFakePage({ url: 'https://www.tiktok.com/@someone/live' });
        const pages = [broken, working];
        let index = 0;

        const sender = createBrowserCommentSender({
            createSession: async () => ({
                async prepare() {
                    return pages[Math.min(index++, pages.length - 1)];
                },
                async close() {}
            }),
            timeoutMs: 120
        });

        await assert.rejects(sender.sendComment({ uniqueId: 'someone', content: 'nope', session }));
        await sender.sendComment({ uniqueId: 'someone', content: 'ok', session });

        assert.deepEqual(working.events.slice(-2), ['type ok', 'press Enter']);
    });

    test('prewarm opens the room page before any comment is typed', async () => {
        const page = createFakePage();
        const sender = createBrowserCommentSender({
            createSession: async () => createSession(page),
            timeoutMs: 2_000
        });

        await sender.prewarm({ uniqueId: 'someone', session });

        assert.deepEqual(page.events, ['goto https://www.tiktok.com/@someone/live']);
    });

    test('prewarm and send share one queue, so a warm page is reused', async () => {
        const page = createFakePage();
        const sender = createBrowserCommentSender({
            createSession: async () => createSession(page),
            timeoutMs: 2_000
        });

        await sender.prewarm({ uniqueId: 'someone', session });
        await sender.sendComment({ uniqueId: 'someone', content: 'hi', session });

        assert.equal(page.events.filter((event) => event.startsWith('goto')).length, 1);
        assert.deepEqual(page.events.slice(-2), ['type hi', 'press Enter']);
    });

    test('close() releases the browser session it opened', async () => {
        const page = createFakePage({ url: 'https://www.tiktok.com/@someone/live' });
        let closed = 0;
        const sender = createBrowserCommentSender({
            createSession: async () => ({
                async prepare() {
                    return page;
                },
                async close() {
                    closed += 1;
                }
            }),
            timeoutMs: 2_000
        });

        await sender.sendComment({ uniqueId: 'someone', content: 'hi', session });
        await sender.close();

        assert.equal(closed, 1);
    });

    test('close() before any send does not launch a browser', async () => {
        let created = 0;
        const sender = createBrowserCommentSender({
            createSession: async () => {
                created += 1;
                return { async prepare() { throw new Error('unused'); }, async close() {} };
            },
            timeoutMs: 2_000
        });

        await sender.close();

        assert.equal(created, 0);
    });

});
