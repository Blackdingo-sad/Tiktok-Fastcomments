import http from 'node:http';
import https from 'node:https';
// Import the package entry point, not src/lib/client: the library has circular
// imports, and starting at the client module leaves the legacy export in a TDZ.
import { EulerSigner, TikTokLiveConnection } from '../src/index';
import { ControlEvent, WebcastEvent } from '../src/types/events';
import { AppError } from './errors';
import { createBrowserCommentSender, type BrowserSender } from './browser-send';
import { createChromeSession } from './browser-launch';
import type { EchoChatData, EchoConnection } from './echo';
import type { ServerConfig } from './config';
import type { SessionStore } from './session';

export interface LiveAdapters {
    resolveRoomId(uniqueId: string): Promise<string>;
    fetchIsLive(uniqueId: string): Promise<boolean>;
    sendComment(params: { uniqueId: string; content: string; roomId: string }): Promise<void>;
    createEchoConnection(uniqueId: string): EchoConnection;
    /**
     * Opens the browser window and the LIVE page ahead of the first comment.
     * A no-op for the HTTP providers, which have nothing to warm.
     */
    warmBrowser(uniqueId: string): Promise<void>;
    /** Applies the chosen delay to manual Enter presses in the browser window. */
    setBrowserSendDelay(delayMs: number): Promise<void>;
    /** Releases anything long-lived this adapter owns (the browser provider does). */
    close(): Promise<void>;
}

const MAX_CACHED_CONNECTIONS = 10;

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : '';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function mapLookupError(error: unknown): AppError {
    if (error instanceof AppError) return error;

    const name = errorName(error);
    const message = errorMessage(error);

    if (name === 'PremiumFeatureError') {
        return new AppError(502, 'provider_plan_required',
            'Dịch vụ tìm phòng yêu cầu gói API trả phí.', { cause: error });
    }
    // Euler answers 401 with a plain message for plan-gated routes, so match the
    // text: otherwise the operator sees a generic provider error and cannot tell
    // that the key's plan is the problem.
    if (/premium|add-on|\bplan\b/i.test(message)) {
        return new AppError(502, 'provider_plan_required',
            'Gói Euler Stream hiện tại không bao gồm route tra phòng (cần Business plan).', { cause: error });
    }
    if (name === 'FetchIsLiveError' || /offline|room id/i.test(message)) {
        return new AppError(409, 'stream_unavailable',
            'Không tìm thấy phòng LIVE cho username này; kênh có thể đang offline.', { cause: error });
    }
    if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) {
        return new AppError(504, 'provider_timeout',
            'Dịch vụ TikTok/Euler không phản hồi kịp khi tìm phòng.', { cause: error });
    }
    return new AppError(502, 'room_lookup_failed',
        'Không tìm được phòng LIVE từ TikTok/Euler.', { cause: error });
}

function mapSendError(error: unknown): AppError {
    if (error instanceof AppError) return error;

    const name = errorName(error);
    const message = errorMessage(error);

    if (name === 'PremiumFeatureError') {
        return new AppError(502, 'provider_plan_required',
            'Dịch vụ gửi chưa được cấp quyền hoặc gói API đã hết hạn.', { cause: error });
    }
    if (/premium|add-on|\bplan\b/i.test(message)) {
        return new AppError(502, 'provider_plan_required',
            'Gói Euler Stream hiện tại không gửi được bình luận: cần add-on Webcast Premium.',
            { cause: error });
    }
    if (name === 'UserOfflineError') {
        return new AppError(409, 'stream_unavailable',
            'Kênh không còn LIVE nên không gửi được bình luận.', { cause: error });
    }
    // Checked before the session wording: TikTok's 403 body can mention
    // "session" in passing, and the HTTP status is the reliable fact here.
    const httpStatus = /\bTikTok answered HTTP (\d{3})\b/i.exec(message)?.[1];
    if (httpStatus !== undefined) {
        const detail = /TikTok said: (.+)$/s.exec(message)?.[1]?.trim() ?? '';
        // A bare 403 with no body comes from TikTok's anti-bot edge, not from
        // the account: the request needs the web signature (X-Bogus/msToken).
        // Saying so saves the operator from chasing a session that is fine.
        const emptyBodyHint = httpStatus === '403' && detail === ''
            ? ' Bị chặn ở tầng chống bot (không có nội dung trả về): request thiếu chữ ký web, không phải lỗi session.'
            : '';
        return new AppError(502, 'provider_http_error',
            `TikTok từ chối yêu cầu gửi bình luận (HTTP ${httpStatus}).`
            + emptyBodyHint
            + (detail === '' ? '' : ` TikTok trả lời: ${detail}`),
            { cause: error });
    }
    if (/session/i.test(message)) {
        return new AppError(502, 'session_rejected',
            'TikTok từ chối session của tài khoản gửi; kiểm tra lại cookie sessionid và tt-target-idc.', { cause: error });
    }
    if (/timeout|ECONNABORTED|ETIMEDOUT/i.test(message)) {
        return new AppError(504, 'provider_timeout',
            'Dịch vụ gửi không phản hồi kịp; bình luận có thể đã được gửi.', { cause: error });
    }
    return new AppError(502, 'provider_error',
        'Dịch vụ gửi bình luận trả về lỗi. Thử lại sau.', { cause: error });
}

/**
 * Real adapters. Credentials are read from the server config only; the desktop
 * client never sees them. Sockets are kept alive and one connector is reused per
 * username so a send does not pay for TCP/TLS setup every time.
 */
export function createLiveAdapters(config: ServerConfig, session: SessionStore): LiveAdapters {

    const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4 });
    const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 4 });

    const signer = new EulerSigner({
        apiKey: config.eulerApiKey ?? undefined,
        baseOptions: {
            httpAgent,
            httpsAgent,
            timeout: config.providerTimeoutMs
        }
    });

    const connections = new Map<string, TikTokLiveConnection>();

    let observerWarningShown = false;
    // Only built when selected: opening a browser is expensive, and the HTTP
    // providers must not pay for it.
    const browserSender: BrowserSender | null = config.sendProvider === 'browser'
        ? createBrowserCommentSender({
            createSession: async () => createChromeSession({ headless: config.browserHeadless }),
            timeoutMs: config.providerTimeoutMs,
            onManualSend: (marker) => {
                void fetch('http://127.0.0.1:8787/measurement/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(marker),
                    signal: AbortSignal.timeout(1_000)
                }).then((response) => {
                    if (!response.ok && response.status !== 409) {
                        console.warn(`[measurement] observer returned HTTP ${response.status}`);
                    }
                }).catch((error: unknown) => {
                    if (observerWarningShown) return;
                    observerWarningShown = true;
                    const cause = typeof error === 'object' && error !== null
                        ? (error as { cause?: { code?: string } }).cause
                        : undefined;
                    const detail = cause?.code === 'ECONNREFUSED'
                        ? 'observer chưa chạy tại 127.0.0.1:8787'
                        : 'không gửi được marker tới observer cục bộ';
                    console.warn(`[measurement] ${detail}; không ảnh hưởng việc gửi thủ công`);
                });
            }
        })
        : null;

    const createConnection = (uniqueId: string): TikTokLiveConnection => {
        const current = session.get();
        return new TikTokLiveConnection(
            uniqueId,
            {
                fetchRoomInfoOnConnect: false,
                processInitialData: false,
                enableRequestPolling: false,
                sessionId: current?.sessionId ?? null,
                ttTargetIdc: current?.ttTargetIdc ?? null,
                signApiKey: config.eulerApiKey,
                // The connector has no browser provider: under `browser` its own
                // send path is never used, and typing it as webcast keeps the
                // option shape valid.
                sendProvider: config.sendProvider === 'euler' ? 'euler' : 'webcast',
                webClientOptions: {
                    httpAgent,
                    httpsAgent,
                    timeout: config.providerTimeoutMs
                }
            },
            signer
        );
    };

    const getConnection = (uniqueId: string): TikTokLiveConnection => {
        const cached = connections.get(uniqueId);
        if (cached !== undefined) {
            // Refresh insertion order so the LRU eviction removes the coldest entry.
            connections.delete(uniqueId);
            connections.set(uniqueId, cached);
            return cached;
        }

        const connection = createConnection(uniqueId);
        connections.set(uniqueId, connection);

        if (connections.size > MAX_CACHED_CONNECTIONS) {
            const oldest = connections.keys().next().value;
            if (oldest !== undefined) connections.delete(oldest);
        }

        return connection;
    };

    return {
        async resolveRoomId(uniqueId: string): Promise<string> {
            const connection = getConnection(uniqueId);
            try {
                const roomId = await connection.fetchRoomId(uniqueId);
                if (typeof roomId !== 'string' || roomId === '') {
                    throw new AppError(409, 'stream_unavailable',
                        'Không lấy được room ID; kênh có thể đang offline.');
                }
                return roomId;
            } catch (error) {
                throw mapLookupError(error);
            }
        },

        async fetchIsLive(uniqueId: string): Promise<boolean> {
            const connection = getConnection(uniqueId);
            try {
                return await connection.fetchIsLive();
            } catch (error) {
                throw mapLookupError(error);
            }
        },

        async sendComment({ uniqueId, content, roomId }): Promise<void> {
            try {
                const current = session.get();
                if (current === null) {
                    throw new AppError(409, 'session_missing',
                        'Chưa có phiên TikTok để gửi; kết nối tài khoản trước khi gửi bình luận.');
                }

                // The browser path posts nothing here: the LIVE page sends with
                // TikTok's own signature, which this HTTP route cannot produce.
                if (browserSender !== null) {
                    await browserSender.sendComment({ uniqueId, content, session: current });
                    return;
                }

                const connection = getConnection(uniqueId);
                // Re-apply on every send: the login window can replace the
                // session while connections stay cached.
                connection.webClient.cookieJar.setSession(current.sessionId, current.ttTargetIdc);
                await connection.sendMessage(content, { roomId });
            } catch (error) {
                throw mapSendError(error);
            }
        },

        async warmBrowser(uniqueId: string): Promise<void> {
            if (browserSender === null) return;
            // Without a session the page would open logged out; the send will
            // report that far more clearly than a silent preview would.
            const current = session.get();
            if (current === null) return;
            await browserSender.prewarm({ uniqueId, session: current });
        },

        async setBrowserSendDelay(delayMs: number): Promise<void> {
            if (browserSender === null) {
                throw new AppError(503, 'browser_delay_unavailable',
                    'Điều khiển độ trễ cửa sổ TikTok chỉ khả dụng với provider browser.');
            }
            await browserSender.setDelay(delayMs);
        },

        async close(): Promise<void> {
            // Without this the Playwright-launched Chrome outlives the backend
            // and the operator has to close it by hand after every restart.
            await browserSender?.close();
        },

        createEchoConnection(uniqueId: string): EchoConnection {
            const connection = new TikTokLiveConnection(
                uniqueId,
                {
                    fetchRoomInfoOnConnect: false,
                    processInitialData: false,
                    enableRequestPolling: false,
                    signApiKey: config.eulerApiKey,
                    webClientOptions: {
                        httpAgent,
                        httpsAgent,
                        timeout: config.providerTimeoutMs
                    }
                },
                signer
            );

            return {
                onChat(handler) {
                    connection.on(WebcastEvent.CHAT, (data) => handler(data as unknown as EchoChatData));
                },
                onClosed(handler) {
                    connection.on(ControlEvent.DISCONNECTED, handler);
                    connection.on(WebcastEvent.STREAM_END, handler);
                },
                connect: () => connection.connect(),
                disconnect: () => connection.disconnect()
            };
        }
    };
}
