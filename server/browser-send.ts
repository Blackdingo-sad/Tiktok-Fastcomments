import { AppError } from './errors';

/**
 * Sends a comment by typing it into the LIVE page in a real Chrome window,
 * because TikTok's webcast HTTP endpoints answer 403 to any request that is not
 * signed by their web SDK. The browser runs that SDK itself, so the request the
 * page makes is a normal, signed one.
 *
 * The page is driven through the small slice below instead of Playwright types
 * so the decision logic stays testable without launching a browser.
 */
export interface BrowserPageLike {
    url(): string;
    goto(
        url: string,
        options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }
    ): Promise<unknown>;
    waitForSelector(
        selector: string,
        options?: { state?: 'attached' | 'visible'; timeout?: number }
    ): Promise<unknown>;
    click(selector: string, options?: { timeout?: number }): Promise<void>;
    innerText(selector: string): Promise<string>;
    keyboard: {
        insertText(text: string): Promise<void>;
        press(key: string): Promise<void>;
    };
}

export interface BrowserSessionLike {
    /** A page showing `uniqueId`, with the current TikTok cookies applied. */
    prepare(session: { sessionId: string; ttTargetIdc: string }): Promise<BrowserPageLike>;
    close(): Promise<void>;
}

/**
 * Candidate chat inputs, most specific first. TikTok renames these between
 * releases, so the list is tried in order and the caller gets a clear error
 * rather than a silent no-op when every entry misses.
 */
export const CHAT_INPUT_SELECTORS = [
    'div[data-e2e="chat-input"]',
    '[data-e2e="comment-input"]',
    'div[contenteditable="true"]',
    'textarea[placeholder]'
];

/** How long one selector gets before the next candidate is tried. */
const SELECTOR_SLICE_MS = 1_000;

/**
 * How long the input gets to clear after Enter. TikTok empties it as soon as it
 * accepts the comment, so a still-full input means the keypress did not send.
 */
const SEND_CONFIRM_MS = 1_000;
const SEND_CONFIRM_POLL_MS = 50;

export function livePageUrl(uniqueId: string): string {
    return `https://www.tiktok.com/@${uniqueId}/live`;
}

async function findChatInput(page: BrowserPageLike, deadline: number): Promise<string | null> {
    while (Date.now() < deadline) {
        for (const selector of CHAT_INPUT_SELECTORS) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return null;
            try {
                await page.waitForSelector(selector, {
                    state: 'visible',
                    timeout: Math.min(SELECTOR_SLICE_MS, remaining)
                });
                return selector;
            } catch {
                // Not there yet (or not this TikTok build): try the next one.
            }
        }
    }
    return null;
}

/**
 * Type `content` into the room's chat input and press Enter. The caller keeps
 * the page warm between sends, so a repeat send usually skips the navigation.
 */
/** Opens the LIVE page unless this page is already on it. */
async function openLivePage(page: BrowserPageLike, uniqueId: string, deadline: number): Promise<void> {
    if (page.url().includes(`/@${uniqueId}/live`)) return;
    await page.goto(livePageUrl(uniqueId), {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1_000, deadline - Date.now())
    });
}

/** True once the chat input is empty again, i.e. TikTok took the comment. */
async function waitForInputToClear(page: BrowserPageLike, selector: string): Promise<boolean> {
    const deadline = Date.now() + SEND_CONFIRM_MS;
    while (Date.now() < deadline) {
        try {
            if ((await page.innerText(selector)).trim() === '') return true;
        } catch {
            // The node was replaced while sending: treat as cleared and stop.
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, SEND_CONFIRM_POLL_MS));
    }
    return false;
}

export async function typeCommentIntoLivePage(
    page: BrowserPageLike,
    params: { uniqueId: string; content: string; timeoutMs: number }
): Promise<void> {
    const { uniqueId, timeoutMs } = params;
    // LIVE chat is one line: a newline would post half the comment.
    const content = params.content.replace(/\r?\n/g, ' ');
    const deadline = Date.now() + timeoutMs;

    await openLivePage(page, uniqueId, deadline);

    const selector = await findChatInput(page, deadline);
    if (selector === null) {
        throw new AppError(502, 'browser_input_missing',
            'Không tìm thấy ô bình luận trên trang LIVE: TikTok có thể đã đổi giao diện, '
            + 'hoặc cửa sổ Chrome chưa đăng nhập đúng tài khoản.');
    }

    await page.click(selector, { timeout: Math.max(500, deadline - Date.now()) });
    await page.keyboard.insertText(content);
    await page.keyboard.press('Enter');

    // Without this the app would report success for a click that landed on the
    // wrong element, or for a chat that silently refused the comment.
    if (!await waitForInputToClear(page, selector)) {
        throw new AppError(502, 'browser_send_unconfirmed',
            'Đã gõ bình luận và nhấn Enter nhưng ô chat không được gửi đi. '
            + 'Kiểm tra cửa sổ Chrome: có thể phiên đã hết hạn, chat bị tắt, hoặc TikTok đổi giao diện.');
    }
}

export interface BrowserSenderOptions {
    createSession: () => Promise<BrowserSessionLike>;
    timeoutMs: number;
}

export interface BrowserSender {
    sendComment(params: {
        uniqueId: string;
        content: string;
        session: { sessionId: string; ttTargetIdc: string };
    }): Promise<void>;
    /** Opens the Chrome window and the LIVE page before the first comment. */
    prewarm(params: {
        uniqueId: string;
        session: { sessionId: string; ttTargetIdc: string };
    }): Promise<void>;
    close(): Promise<void>;
}

export function createBrowserCommentSender(options: BrowserSenderOptions): BrowserSender {

    let sessionPromise: Promise<BrowserSessionLike> | null = null;
    // Sends are serialised: two comments must not fight over the same input box.
    let queue: Promise<unknown> = Promise.resolve();

    const getSession = (): Promise<BrowserSessionLike> => {
        if (sessionPromise === null) {
            sessionPromise = options.createSession().catch((error) => {
                sessionPromise = null;
                throw error;
            });
        }
        return sessionPromise;
    };

    return {
        sendComment({ uniqueId, content, session }): Promise<void> {
            const run = queue.then(async () => {
                const page = await (await getSession()).prepare(session);
                await typeCommentIntoLivePage(page, { uniqueId, content, timeoutMs: options.timeoutMs });
            });
            // Keep the chain alive after a failure so one bad send does not block
            // every later one; the caller still sees the rejection.
            queue = run.catch(() => undefined);
            return run;
        },

        prewarm({ uniqueId, session }): Promise<void> {
            const run = queue.then(async () => {
                const page = await (await getSession()).prepare(session);
                await openLivePage(page, uniqueId, Date.now() + options.timeoutMs);
            });
            queue = run.catch(() => undefined);
            return run;
        },

        async close(): Promise<void> {
            if (sessionPromise === null) return;
            const session = await sessionPromise.catch(() => null);
            await session?.close();
        }
    };
}
